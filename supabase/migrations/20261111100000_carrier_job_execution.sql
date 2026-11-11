-- Carrier job execution (plan docs/plany/realizacja-kursu.md, approved 2026-11-11):
--   * order_leg_steps   per leg: arrived_pickup → loaded → departed → arrived_delivery → unloaded, in this order,
--                       leg after leg; times from the database (now()), never from the phone;
--   * order_photos      photos of the load (pickup) and at delivery, files in the private bucket order-photos;
--   * delivery_proofs   POD: recipient name + signature (bucket pod-signatures), immutable;
--   * porter working time (D69) = (loaded − arrived_pickup) + (unloaded − arrived_delivery), summed in seconds and
--     rounded DOWN to full minutes, computed only here (order_porters_worked_minutes) and stored in
--     order_legs.porters_worked_minutes by complete_delivery;
--   * admin_revert_last_step(): only an admin undoes the last step, with a reason in the status history;
--   * admin_advance_order(): "Consegnato" without POD now requires a reason (note in the status history).
-- Model A (D117): one carrier for all legs. Order status: leg 0 loaded → picked_up, leg 0 departed → in_transit,
-- complete_delivery → delivered. With storage the order stays in_transit while the goods are in the warehouse
-- (known limitation until model B).
-- Positions (lat/lng) and user ids (created_by, uploaded_by, reverted_by) are never readable with a user session
-- (column grants, as D128); admins read them through admin_order_execution() / admin_delivery_proof().
-- Tests: tests/rls/carrier-execution.test.ts.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
-- Declaration order = execution order (order_next_leg_step relies on it).
create type public.order_leg_step as enum ('arrived_pickup', 'loaded', 'departed', 'arrived_delivery', 'unloaded');
create type public.order_photo_kind as enum ('pickup', 'delivery'); -- 'claim' comes with claims (Stage 5)

-- Internal: a (lat, lng) pair or nothing. A bad or partial position never blocks a step (owner, 2026-11-11).
create function public.valid_position(p_lat double precision, p_lng double precision)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_lat is not null and p_lng is not null and p_lat between -90 and 90 and p_lng between -180 and 180;
$$;
revoke execute on function public.valid_position(double precision, double precision) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- order_leg_steps — append-only; a step can only be marked reverted (admin, or automatically when the carrier
-- changes), never edited or deleted.
-- ---------------------------------------------------------------------------
create table public.order_leg_steps (
  id          bigint generated always as identity primary key,
  order_id    uuid not null,
  leg_index   smallint not null,
  step        public.order_leg_step not null,
  created_at  timestamptz not null default now(),
  created_by  uuid not null,                -- no FK: survives account deletion, like the status history
  lat         double precision check (lat between -90 and 90),
  lng         double precision check (lng between -180 and 180),
  reverted_at timestamptz,
  reverted_by uuid,                         -- admin; null when reverted because the carrier changed
  foreign key (order_id, leg_index) references public.order_legs (order_id, leg_index) on delete cascade,
  check ((lat is null) = (lng is null)),
  check (reverted_by is null or reverted_at is not null)
);

-- One live step per leg and kind: a double click cannot create a duplicate.
create unique index order_leg_steps_live_uq on public.order_leg_steps (order_id, leg_index, step) where reverted_at is null;
create index order_leg_steps_order_idx on public.order_leg_steps (order_id, id);

create function public.guard_order_leg_steps()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.reverted_at is null and new.reverted_at is not null
     and (to_jsonb(new) - 'reverted_at' - 'reverted_by') = (to_jsonb(old) - 'reverted_at' - 'reverted_by') then
    return new;
  end if;
  raise exception 'order_leg_steps: rows are append-only (only reverting is allowed)' using errcode = '42501';
end;
$$;

create trigger order_leg_steps_guard
  before update or delete on public.order_leg_steps
  for each row execute function public.guard_order_leg_steps();
create trigger order_leg_steps_no_truncate
  before truncate on public.order_leg_steps
  for each statement execute function public.reject_change();

-- ---------------------------------------------------------------------------
-- order_photos — rows written only by register_order_photo / delete_order_photo
-- ---------------------------------------------------------------------------
create table public.order_photos (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null,
  leg_index    smallint not null,
  kind         public.order_photo_kind not null,
  storage_path text not null unique,       -- order-photos bucket: {order_id}/{uuid}.jpg
  size_bytes   integer not null check (size_bytes between 1 and 5242880),
  uploaded_by  uuid not null,
  created_at   timestamptz not null default now(),
  foreign key (order_id, leg_index) references public.order_legs (order_id, leg_index) on delete cascade,
  check (storage_path like order_id::text || '/%.jpg')
);
create index order_photos_order_idx on public.order_photos (order_id, leg_index, kind);

create trigger order_photos_no_update
  before update on public.order_photos
  for each row execute function public.reject_change();

-- ---------------------------------------------------------------------------
-- delivery_proofs — POD, 1:1 with the order, immutable for every role
-- ---------------------------------------------------------------------------
create table public.delivery_proofs (
  order_id       uuid primary key references public.orders (id) on delete cascade,
  recipient_name text not null check (length(trim(recipient_name)) between 1 and 200),
  signature_path text not null unique,     -- pod-signatures bucket: {order_id}/{uuid}.png
  signed_at      timestamptz not null default now(),
  created_by     uuid not null,
  lat            double precision check (lat between -90 and 90),
  lng            double precision check (lng between -180 and 180),
  check ((lat is null) = (lng is null)),
  check (signature_path like order_id::text || '/%.png')
);

create trigger delivery_proofs_immutable
  before update or delete on public.delivery_proofs
  for each row execute function public.reject_change();
create trigger delivery_proofs_no_truncate
  before truncate on public.delivery_proofs
  for each statement execute function public.reject_change();

-- ---------------------------------------------------------------------------
-- Privileges: sessions read only (selected columns); writes only through the functions below.
-- ---------------------------------------------------------------------------
revoke all on public.order_leg_steps, public.order_photos, public.delivery_proofs from anon, authenticated, service_role;
grant select (id, order_id, leg_index, step, created_at, reverted_at) on public.order_leg_steps to authenticated;
grant select (id, order_id, leg_index, kind, storage_path, size_bytes, created_at) on public.order_photos to authenticated;
grant select (order_id, recipient_name, signature_path, signed_at) on public.delivery_proofs to authenticated;
grant select on public.order_leg_steps, public.order_photos, public.delivery_proofs to service_role;

alter table public.order_leg_steps enable row level security;
alter table public.order_photos enable row level security;
alter table public.delivery_proofs enable row level security;

-- Steps: the customer (own order), the carrier (only since its own assignment — nothing of a previous carrier),
-- admins.
create policy order_leg_steps_select_customer on public.order_leg_steps
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_leg_steps.order_id
      and o.customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente'
  ));
create policy order_leg_steps_select_carrier on public.order_leg_steps
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_leg_steps.order_id
      and o.carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino'
      and order_leg_steps.created_at >= o.assigned_at
  ));
create policy order_leg_steps_select_admin on public.order_leg_steps
  for select to authenticated
  using ((select public.is_admin()));

-- Photos: the customer (own order), the carrier (its OWN photos of an order still assigned to it), admins.
create policy order_photos_select_customer on public.order_photos
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_photos.order_id
      and o.customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente'
  ));
create policy order_photos_select_carrier on public.order_photos
  for select to authenticated
  using (
    uploaded_by = (select auth.uid())
    and exists (
      select 1 from public.orders o
      where o.id = order_photos.order_id
        and o.carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino'
    )
  );
create policy order_photos_select_admin on public.order_photos
  for select to authenticated
  using ((select public.is_admin()));

-- POD: the customer and the assigned carrier, admins.
create policy delivery_proofs_select_parties on public.delivery_proofs
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = delivery_proofs.order_id
      and ((o.customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente')
        or (o.carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino'))
  ));
create policy delivery_proofs_select_admin on public.delivery_proofs
  for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Storage: private buckets. Upload: the assigned carrier, into the folder of its order while the job is running.
-- No update/delete from browsers (a removed photo's file is deleted by the server).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('order-photos', 'order-photos', false, 5242880, array['image/jpeg']),     -- 5 MB, JPEG made by the browser
  ('pod-signatures', 'pod-signatures', false, 524288, array['image/png'])    -- 512 KB
on conflict (id) do nothing;

create policy order_photos_storage_insert_carrier on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-photos'
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
    and (select public.auth_role()) = 'padroncino'
    and exists (
      select 1 from public.orders o
      where o.id::text = (storage.foldername(name))[1]
        and o.carrier_id = (select auth.uid()) and o.status in ('assigned', 'picked_up', 'in_transit')
    )
  );

create policy pod_signatures_storage_insert_carrier on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'pod-signatures'
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.png$'
    and (select public.auth_role()) = 'padroncino'
    and exists (
      select 1 from public.orders o
      where o.id::text = (storage.foldername(name))[1]
        and o.carrier_id = (select auth.uid()) and o.status = 'in_transit'
    )
  );

-- Carrier: its own files of an order still assigned to it (needed by the upload and for the previews).
create policy order_files_storage_select_carrier on storage.objects
  for select to authenticated
  using (
    bucket_id in ('order-photos', 'pod-signatures')
    and owner_id = (select auth.uid())::text
    and (select public.auth_role()) = 'padroncino'
    and exists (
      select 1 from public.orders o
      where o.id::text = (storage.foldername(name))[1] and o.carrier_id = (select auth.uid())
    )
  );

-- Customer: only files registered for its own order (RLS of order_photos / delivery_proofs decides).
create policy order_photos_storage_select_customer on storage.objects
  for select to authenticated
  using (
    bucket_id = 'order-photos' and (select public.auth_role()) = 'cliente'
    and exists (select 1 from public.order_photos p where p.storage_path = name)
  );
create policy pod_signatures_storage_select_customer on storage.objects
  for select to authenticated
  using (
    bucket_id = 'pod-signatures' and (select public.auth_role()) = 'cliente'
    and exists (select 1 from public.delivery_proofs d where d.signature_path = name)
  );

create policy order_files_storage_select_admin on storage.objects
  for select to authenticated
  using (bucket_id in ('order-photos', 'pod-signatures') and (select public.is_admin()));

-- ---------------------------------------------------------------------------
-- A new carrier never inherits the steps of the previous one: when orders.carrier_id changes (release_job,
-- admin_unassign_job — both only in 'assigned', so at most arrived_pickup exists), live steps are reverted.
-- Photos stay (admins see them); the new carrier sees only its own.
-- ---------------------------------------------------------------------------
create function public.revert_steps_on_carrier_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.order_leg_steps
     set reverted_at = now()
   where order_id = new.id and reverted_at is null;
  return new;
end;
$$;
revoke execute on function public.revert_steps_on_carrier_change() from public, anon, authenticated;

create trigger orders_revert_steps_on_carrier_change
  after update of carrier_id on public.orders
  for each row
  when (old.carrier_id is not null and old.carrier_id is distinct from new.carrier_id)
  execute function public.revert_steps_on_carrier_change();

-- ---------------------------------------------------------------------------
-- Internal: the next step of an order (first leg, first step without a live row); none = all legs unloaded.
-- ---------------------------------------------------------------------------
create function public.order_next_leg_step(p_order_id uuid)
returns table (leg_index smallint, step public.order_leg_step)
language sql
stable
set search_path = ''
as $$
  select l.leg_index, s.step
  from public.order_legs l
  cross join lateral unnest(enum_range(null::public.order_leg_step)) with ordinality as s(step, ord)
  where l.order_id = p_order_id
    and not exists (
      select 1 from public.order_leg_steps x
      where x.order_id = l.order_id and x.leg_index = l.leg_index and x.step = s.step and x.reverted_at is null
    )
  order by l.leg_index, s.ord
  limit 1;
$$;
revoke execute on function public.order_next_leg_step(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- order_porters_worked_minutes(order): porter working time per leg with porters (D69), computed ONLY here.
-- (loaded − arrived_pickup) + (unloaded − arrived_delivery): each half only when both steps exist; the seconds
-- are summed and rounded DOWN to full minutes (owner, 2026-11-11). complete = all four steps recorded.
-- SECURITY INVOKER: a session sees only the steps its RLS allows (customer / assigned carrier / admin).
-- ---------------------------------------------------------------------------
create function public.order_porters_worked_minutes(p_order_id uuid)
returns table (leg_index smallint, worked_minutes integer, complete boolean)
language sql
stable
set search_path = ''
as $$
  with s as (
    select x.leg_index, x.step, x.created_at
    from public.order_leg_steps x
    where x.order_id = p_order_id and x.reverted_at is null
  ), t as (
    select l.leg_index,
           max(s.created_at) filter (where s.step = 'arrived_pickup') as ap,
           max(s.created_at) filter (where s.step = 'loaded') as lo,
           max(s.created_at) filter (where s.step = 'arrived_delivery') as ad,
           max(s.created_at) filter (where s.step = 'unloaded') as un
    from public.order_legs l
    left join s on s.leg_index = l.leg_index
    where l.order_id = p_order_id and l.porters_count > 0
    group by l.leg_index
  )
  select t.leg_index,
         floor(extract(epoch from coalesce(t.lo - t.ap, interval '0') + coalesce(t.un - t.ad, interval '0')) / 60)::integer,
         (t.ap is not null and t.lo is not null and t.ad is not null and t.un is not null)
  from t
  order by t.leg_index;
$$;
revoke execute on function public.order_porters_worked_minutes(uuid) from public, anon;
grant execute on function public.order_porters_worked_minutes(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- carrier_record_step(order, leg, step, lat, lng): the assigned carrier records the NEXT step.
-- * Same step again (double click, retry) → the existing row, newly_recorded = false, no error.
-- * Only in order: the next step is the first missing one (leg after leg) — wrong_step otherwise.
-- * arrived_pickup only from the pickup day of that leg (Europe/Rome) — too_early; on leg 0 this does not apply
--   once the admin has moved the order past 'assigned' (admin starts the job early, owner 2026-11-11).
-- * loaded / unloaded need ≥ 1 own photo of that leg (pickup / delivery) — photo_required.
-- * Statuses only forward: leg 0 loaded → picked_up, leg 0 departed → in_transit (history carrier_app, with the
--   position). Works for a suspended carrier too (D116).
-- * Position: optional, ignored when invalid; readable by admins only.
-- Errors: 42501 not a carrier | 22023 leg | 55000 not_assigned | not_in_progress | wrong_step (detail
--         'wrong_step:<leg>:<next step>' or 'wrong_step:done') | too_early | photo_required
-- ---------------------------------------------------------------------------
create function public.carrier_record_step(
  p_order_id uuid, p_leg_index smallint, p_step public.order_leg_step,
  p_lat double precision default null, p_lng double precision default null
)
returns table (recorded_at timestamptz, newly_recorded boolean, order_status public.order_status)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me     uuid := public.require_carrier();
  v_order  public.orders%rowtype;
  v_leg    public.order_legs%rowtype;
  v_at     timestamptz;
  v_next   record;
  v_target public.order_status;
  v_pos    boolean := public.valid_position(p_lat, p_lng);
  v_now    timestamptz := now();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.carrier_id is distinct from v_me then
    raise exception 'carrier_record_step: not assigned to this carrier' using errcode = '55000', detail = 'not_assigned';
  end if;
  select * into v_leg from public.order_legs where order_id = p_order_id and leg_index = p_leg_index;
  if not found or p_step is null then
    raise exception 'carrier_record_step: unknown leg or step' using errcode = '22023', detail = 'leg';
  end if;

  -- idempotent: the same step again returns the recorded one
  select created_at into v_at from public.order_leg_steps
   where order_id = p_order_id and leg_index = p_leg_index and step = p_step and reverted_at is null;
  if found then
    return query select v_at, false, v_order.status;
    return;
  end if;

  if v_order.status not in ('assigned', 'picked_up', 'in_transit') then
    raise exception 'carrier_record_step: job not in progress' using errcode = '55000', detail = 'not_in_progress';
  end if;

  select * into v_next from public.order_next_leg_step(p_order_id);
  if not found then
    raise exception 'carrier_record_step: all steps done' using errcode = '55000', detail = 'wrong_step:done';
  end if;
  if v_next.leg_index <> p_leg_index or v_next.step <> p_step then
    raise exception 'carrier_record_step: not the next step' using errcode = '55000',
      detail = 'wrong_step:' || v_next.leg_index || ':' || v_next.step;
  end if;

  if p_step = 'arrived_pickup'
     and (v_leg.pickup_window_start at time zone 'Europe/Rome')::date > (v_now at time zone 'Europe/Rome')::date
     and not (p_leg_index = 0 and v_order.status <> 'assigned') then
    raise exception 'carrier_record_step: before the pickup day' using errcode = '55000', detail = 'too_early';
  end if;

  if p_step in ('loaded', 'unloaded') and not exists (
    select 1 from public.order_photos ph
    where ph.order_id = p_order_id and ph.leg_index = p_leg_index and ph.uploaded_by = v_me
      and ph.kind = case when p_step = 'loaded' then 'pickup'::public.order_photo_kind else 'delivery'::public.order_photo_kind end
  ) then
    raise exception 'carrier_record_step: photo required' using errcode = '55000', detail = 'photo_required';
  end if;

  insert into public.order_leg_steps (order_id, leg_index, step, created_at, created_by, lat, lng)
  values (p_order_id, p_leg_index, p_step, v_now, v_me,
          case when v_pos then p_lat end, case when v_pos then p_lng end);

  v_target := case
                when p_leg_index = 0 and p_step = 'loaded' then 'picked_up'::public.order_status
                when p_leg_index = 0 and p_step = 'departed' then 'in_transit'::public.order_status
              end;
  -- forward only: assigned < picked_up < in_transit
  if v_target is not null
     and array_position(array['assigned', 'picked_up', 'in_transit']::public.order_status[], v_target)
       > array_position(array['assigned', 'picked_up', 'in_transit']::public.order_status[], v_order.status) then
    update public.orders
       set status = v_target,
           picked_up_at = case when v_target = 'picked_up' then v_now else picked_up_at end,
           in_transit_at = case when v_target = 'in_transit' then v_now else in_transit_at end
     where id = p_order_id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, lat, lng, created_at)
    values (p_order_id, v_order.status, v_target, v_me, 'carrier_app',
            case when v_pos then p_lat end, case when v_pos then p_lng end, v_now);
    v_order.status := v_target;
  end if;

  return query select v_now, true, v_order.status;
end;
$$;
revoke execute on function public.carrier_record_step(uuid, smallint, public.order_leg_step, double precision, double precision) from public, anon;
grant execute on function public.carrier_record_step(uuid, smallint, public.order_leg_step, double precision, double precision) to authenticated;

-- ---------------------------------------------------------------------------
-- register_order_photo(order, leg, kind, path): after the browser uploaded the file to order-photos.
-- Checks the object in Storage (exists, uploaded by this carrier, image/jpeg, ≤ 5 MB) and that the step the photo
-- belongs to (loaded / unloaded of that leg) is still open. Max 10 own photos per leg and kind.
-- Same path again ("Riprova" after a lost response) → the existing row, newly_registered = false.
-- Errors: 42501 | 22023 leg / path / file | 55000 not_assigned | not_in_progress | step_closed | too_many_photos
-- ---------------------------------------------------------------------------
create function public.register_order_photo(
  p_order_id uuid, p_leg_index smallint, p_kind public.order_photo_kind, p_storage_path text
)
returns table (photo_id uuid, newly_registered boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c_max   constant integer := 10;
  v_me    uuid := public.require_carrier();
  v_order public.orders%rowtype;
  v_photo public.order_photos%rowtype;
  v_obj   record;
  v_size  bigint;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.carrier_id is distinct from v_me then
    raise exception 'register_order_photo: not assigned to this carrier' using errcode = '55000', detail = 'not_assigned';
  end if;

  select * into v_photo from public.order_photos where storage_path = p_storage_path;
  if found then
    if v_photo.uploaded_by = v_me and v_photo.order_id = p_order_id and v_photo.leg_index = p_leg_index and v_photo.kind = p_kind then
      return query select v_photo.id, false;
      return;
    end if;
    raise exception 'register_order_photo: path already used' using errcode = '22023', detail = 'path';
  end if;

  if v_order.status not in ('assigned', 'picked_up', 'in_transit') then
    raise exception 'register_order_photo: job not in progress' using errcode = '55000', detail = 'not_in_progress';
  end if;
  if p_kind is null or not exists (select 1 from public.order_legs where order_id = p_order_id and leg_index = p_leg_index) then
    raise exception 'register_order_photo: unknown leg' using errcode = '22023', detail = 'leg';
  end if;
  if p_storage_path is null or p_storage_path !~ ('^' || p_order_id::text || '/[0-9a-f-]{36}\.jpg$') then
    raise exception 'register_order_photo: bad path' using errcode = '22023', detail = 'path';
  end if;
  if exists (
    select 1 from public.order_leg_steps
    where order_id = p_order_id and leg_index = p_leg_index and reverted_at is null
      and step = case when p_kind = 'pickup' then 'loaded'::public.order_leg_step else 'unloaded'::public.order_leg_step end
  ) then
    raise exception 'register_order_photo: step already closed' using errcode = '55000', detail = 'step_closed';
  end if;

  select o.owner_id, o.metadata into v_obj
  from storage.objects o
  where o.bucket_id = 'order-photos' and o.name = p_storage_path and o.archived_at is null and not o.is_delete_marker;
  v_size := nullif(v_obj.metadata ->> 'size', '')::bigint;
  if v_obj is null or v_obj.owner_id is distinct from v_me::text
     or v_obj.metadata ->> 'mimetype' is distinct from 'image/jpeg'
     or v_size is null or v_size not between 1 and 5242880 then
    raise exception 'register_order_photo: file missing or not valid' using errcode = '22023', detail = 'file';
  end if;

  if (select count(*) from public.order_photos
      where order_id = p_order_id and leg_index = p_leg_index and kind = p_kind and uploaded_by = v_me) >= c_max then
    raise exception 'register_order_photo: too many photos' using errcode = '55000', detail = 'too_many_photos';
  end if;

  insert into public.order_photos (order_id, leg_index, kind, storage_path, size_bytes, uploaded_by)
  values (p_order_id, p_leg_index, p_kind, p_storage_path, v_size, v_me)
  returning * into v_photo;
  return query select v_photo.id, true;
end;
$$;
revoke execute on function public.register_order_photo(uuid, smallint, public.order_photo_kind, text) from public, anon;
grant execute on function public.register_order_photo(uuid, smallint, public.order_photo_kind, text) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_order_photo(photo): the author removes its photo while the step it belongs to is still open.
-- Returns the storage path (the server then deletes the file); an already deleted photo → null, no error.
-- Errors: 42501 | 55000 not_assigned | not_in_progress | step_closed
-- ---------------------------------------------------------------------------
create function public.delete_order_photo(p_photo_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := public.require_carrier();
  v_photo public.order_photos%rowtype;
  v_order public.orders%rowtype;
begin
  select * into v_photo from public.order_photos where id = p_photo_id and uploaded_by = v_me;
  if not found then
    return null;
  end if;
  select * into v_order from public.orders where id = v_photo.order_id for update;
  if v_order.carrier_id is distinct from v_me then
    raise exception 'delete_order_photo: not assigned to this carrier' using errcode = '55000', detail = 'not_assigned';
  end if;
  if v_order.status not in ('assigned', 'picked_up', 'in_transit') then
    raise exception 'delete_order_photo: job not in progress' using errcode = '55000', detail = 'not_in_progress';
  end if;
  if exists (
    select 1 from public.order_leg_steps
    where order_id = v_photo.order_id and leg_index = v_photo.leg_index and reverted_at is null
      and step = case when v_photo.kind = 'pickup' then 'loaded'::public.order_leg_step else 'unloaded'::public.order_leg_step end
  ) then
    raise exception 'delete_order_photo: step already closed' using errcode = '55000', detail = 'step_closed';
  end if;
  delete from public.order_photos where id = p_photo_id;
  return v_photo.storage_path;
end;
$$;
revoke execute on function public.delete_order_photo(uuid) from public, anon;
grant execute on function public.delete_order_photo(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- complete_delivery(order, recipient name, signature path, lat, lng): "Conferma consegna" (POD).
-- Requires: in_transit, every step of every leg recorded, ≥ 1 own delivery photo of the last leg, recipient name
-- (required), the signature PNG in pod-signatures (uploaded by this carrier, ≤ 512 KB). In ONE transaction:
-- delivery_proofs, porters_worked_minutes of every leg with porters (order_porters_worked_minutes — the value the
-- recipient saw), in_transit → delivered + delivered_at, history (carrier_app). delivered_without_pod stays false
-- (D123). The payouts row comes in Stage 6. Called again after success → newly_delivered = false, no error.
-- Errors: 42501 | 22023 recipient_name / signature | 55000 not_assigned | not_in_progress | steps_missing
--         | photo_required
-- ---------------------------------------------------------------------------
create function public.complete_delivery(
  p_order_id uuid, p_recipient_name text, p_signature_path text,
  p_lat double precision default null, p_lng double precision default null
)
returns table (delivered_at timestamptz, newly_delivered boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me    uuid := public.require_carrier();
  v_order public.orders%rowtype;
  v_last  smallint;
  v_name  text := trim(coalesce(p_recipient_name, ''));
  v_obj   record;
  v_size  bigint;
  v_pos   boolean := public.valid_position(p_lat, p_lng);
  v_now   timestamptz := now();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.carrier_id is distinct from v_me then
    raise exception 'complete_delivery: not assigned to this carrier' using errcode = '55000', detail = 'not_assigned';
  end if;
  if v_order.status = 'delivered' and exists (select 1 from public.delivery_proofs where order_id = p_order_id and created_by = v_me) then
    return query select v_order.delivered_at, false;
    return;
  end if;
  if v_order.status <> 'in_transit' then
    raise exception 'complete_delivery: job not in transit' using errcode = '55000', detail = 'not_in_progress';
  end if;
  if exists (select 1 from public.order_next_leg_step(p_order_id)) then
    raise exception 'complete_delivery: steps missing' using errcode = '55000', detail = 'steps_missing';
  end if;

  select max(leg_index) into v_last from public.order_legs where order_id = p_order_id;
  if not exists (select 1 from public.order_photos
                 where order_id = p_order_id and leg_index = v_last and kind = 'delivery' and uploaded_by = v_me) then
    raise exception 'complete_delivery: delivery photo required' using errcode = '55000', detail = 'photo_required';
  end if;

  if length(v_name) not between 1 and 200 then
    raise exception 'complete_delivery: recipient name required' using errcode = '22023', detail = 'recipient_name';
  end if;
  if p_signature_path is null or p_signature_path !~ ('^' || p_order_id::text || '/[0-9a-f-]{36}\.png$') then
    raise exception 'complete_delivery: bad signature path' using errcode = '22023', detail = 'signature';
  end if;
  select o.owner_id, o.metadata into v_obj
  from storage.objects o
  where o.bucket_id = 'pod-signatures' and o.name = p_signature_path and o.archived_at is null and not o.is_delete_marker;
  v_size := nullif(v_obj.metadata ->> 'size', '')::bigint;
  if v_obj is null or v_obj.owner_id is distinct from v_me::text
     or v_obj.metadata ->> 'mimetype' is distinct from 'image/png'
     or v_size is null or v_size not between 1 and 524288 then
    raise exception 'complete_delivery: signature file missing or not valid' using errcode = '22023', detail = 'signature';
  end if;

  update public.order_legs l
     set porters_worked_minutes = m.worked_minutes
    from public.order_porters_worked_minutes(p_order_id) m
   where l.order_id = p_order_id and l.leg_index = m.leg_index;

  insert into public.delivery_proofs (order_id, recipient_name, signature_path, signed_at, created_by, lat, lng)
  values (p_order_id, v_name, p_signature_path, v_now, v_me,
          case when v_pos then p_lat end, case when v_pos then p_lng end);

  update public.orders set status = 'delivered', delivered_at = v_now where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, lat, lng, created_at)
  values (p_order_id, 'in_transit', 'delivered', v_me, 'carrier_app',
          case when v_pos then p_lat end, case when v_pos then p_lng end, v_now);

  return query select v_now, true;
end;
$$;
revoke execute on function public.complete_delivery(uuid, text, text, double precision, double precision) from public, anon;
grant execute on function public.complete_delivery(uuid, text, text, double precision, double precision) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_revert_last_step(order, admin, reason): undo the LAST live step (only an admin; the carrier never can).
-- Only while the job runs (assigned / picked_up / in_transit; after delivery nothing is undone here).
-- The status goes back only when the reverted step caused it: leg 0 departed (in_transit → picked_up),
-- leg 0 loaded (picked_up → assigned); the matching *_at is cleared. ALWAYS a status history row (source
-- admin_panel, from → to, possibly the same status) whose note is the reason (owner, 2026-11-11: the reason is in
-- the history — visible to the order's parties, D77). audit_log: ids, leg, step and statuses only (D65).
-- Photos stay; once the step is open again the carrier may remove or add photos.
-- Errors: 42501 | 22023 order / reason | 55000 not_in_progress | no_step
-- ---------------------------------------------------------------------------
create function public.admin_revert_last_step(p_order_id uuid, p_admin_id uuid, p_reason text)
returns table (leg_index smallint, step public.order_leg_step, order_status public.order_status)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email  text := public.require_admin(p_admin_id);
  v_reason text := trim(coalesce(p_reason, ''));
  v_order  public.orders%rowtype;
  v_step   public.order_leg_steps%rowtype;
  v_to     public.order_status;
  v_now    timestamptz := now();
begin
  if length(v_reason) not between 1 and 1000 then
    raise exception 'admin_revert_last_step: reason required' using errcode = '22023', detail = 'reason';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'admin_revert_last_step: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.status not in ('assigned', 'picked_up', 'in_transit') then
    raise exception 'admin_revert_last_step: job not in progress' using errcode = '55000', detail = 'not_in_progress';
  end if;
  select * into v_step from public.order_leg_steps
   where order_id = p_order_id and reverted_at is null
   order by leg_index desc, step desc
   limit 1;
  if not found then
    raise exception 'admin_revert_last_step: no step to undo' using errcode = '55000', detail = 'no_step';
  end if;

  update public.order_leg_steps set reverted_at = v_now, reverted_by = p_admin_id where id = v_step.id;

  v_to := case
            when v_step.leg_index = 0 and v_step.step = 'departed' and v_order.status = 'in_transit' then 'picked_up'::public.order_status
            when v_step.leg_index = 0 and v_step.step = 'loaded' and v_order.status = 'picked_up' then 'assigned'::public.order_status
            else v_order.status
          end;
  if v_to <> v_order.status then
    update public.orders
       set status = v_to,
           in_transit_at = case when v_order.status = 'in_transit' then null else in_transit_at end,
           picked_up_at = case when v_order.status = 'picked_up' then null else picked_up_at end
     where id = p_order_id;
  end if;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, note, created_at)
  values (p_order_id, v_order.status, v_to, p_admin_id, 'admin_panel', v_reason, v_now);
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.step_reverted', 'order', p_order_id,
          jsonb_build_object('leg_index', v_step.leg_index, 'step', v_step.step, 'from', v_order.status, 'to', v_to));

  return query select v_step.leg_index, v_step.step, v_to;
end;
$$;
revoke execute on function public.admin_revert_last_step(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_revert_last_step(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Admin reads (session, is_admin() checked here): every step incl. reverted ones, with who and where; the POD
-- with who and where.
-- ---------------------------------------------------------------------------
create function public.admin_order_execution(p_order_id uuid)
returns table (
  id bigint, leg_index smallint, step public.order_leg_step, created_at timestamptz, created_by uuid,
  lat double precision, lng double precision, reverted_at timestamptz, reverted_by uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_order_execution: admins only' using errcode = '42501';
  end if;
  return query
    select s.id, s.leg_index, s.step, s.created_at, s.created_by, s.lat, s.lng, s.reverted_at, s.reverted_by
    from public.order_leg_steps s
    where s.order_id = p_order_id
    order by s.id;
end;
$$;
revoke execute on function public.admin_order_execution(uuid) from public, anon;
grant execute on function public.admin_order_execution(uuid) to authenticated, service_role;

create function public.admin_delivery_proof(p_order_id uuid)
returns table (
  recipient_name text, signature_path text, signed_at timestamptz, created_by uuid,
  lat double precision, lng double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_delivery_proof: admins only' using errcode = '42501';
  end if;
  return query
    select d.recipient_name, d.signature_path, d.signed_at, d.created_by, d.lat, d.lng
    from public.delivery_proofs d
    where d.order_id = p_order_id;
end;
$$;
revoke execute on function public.admin_delivery_proof(uuid) from public, anon;
grant execute on function public.admin_delivery_proof(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- admin_advance_order: + p_note. "Consegnato" without POD (D123) requires a reason (owner, 2026-11-11), stored as
-- the note of the status history row (visible to the order's parties, D77); optional for the other steps.
-- Errors as before + 22023 'note'.
-- ---------------------------------------------------------------------------
drop function public.admin_advance_order(uuid, uuid, public.order_status);

create function public.admin_advance_order(
  p_order_id uuid, p_admin_id uuid, p_to_status public.order_status, p_note text default null
)
returns public.order_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := public.require_admin(p_admin_id);
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
  v_order public.orders%rowtype;
  v_next  public.order_status;
  v_now   timestamptz := now();
begin
  if p_to_status is null or p_to_status not in ('picked_up', 'in_transit', 'delivered') then
    raise exception 'admin_advance_order: unknown target status' using errcode = '22023', detail = 'status';
  end if;
  if (p_to_status = 'delivered' and v_note is null) or length(v_note) > 1000 then
    raise exception 'admin_advance_order: reason required' using errcode = '22023', detail = 'note';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'admin_advance_order: order not found' using errcode = '22023', detail = 'order';
  end if;
  v_next := case v_order.status
              when 'assigned' then 'picked_up'::public.order_status
              when 'picked_up' then 'in_transit'::public.order_status
              when 'in_transit' then 'delivered'::public.order_status
            end;
  if v_next is distinct from p_to_status then
    raise exception 'admin_advance_order: not the next status' using errcode = '55000', detail = v_order.status::text;
  end if;

  update public.orders
     set status = p_to_status,
         picked_up_at = case when p_to_status = 'picked_up' then v_now else picked_up_at end,
         in_transit_at = case when p_to_status = 'in_transit' then v_now else in_transit_at end,
         delivered_at = case when p_to_status = 'delivered' then v_now else delivered_at end,
         delivered_without_pod = delivered_without_pod or p_to_status = 'delivered'
   where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, note)
  values (p_order_id, v_order.status, p_to_status, p_admin_id, 'admin_panel', v_note);
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.status_changed', 'order', p_order_id,
          jsonb_build_object('from', v_order.status, 'to', p_to_status)
          || case when p_to_status = 'delivered' then jsonb_build_object('pod', false) else '{}'::jsonb end);
  return p_to_status;
end;
$$;
revoke execute on function public.admin_advance_order(uuid, uuid, public.order_status, text) from public, anon, authenticated;
grant execute on function public.admin_advance_order(uuid, uuid, public.order_status, text) to service_role;
