-- Customer claims (spec 4 and 7, D138; plan docs/plany/panel-klienta-2.md, part B).
--
--   * claims        one claim = one order, category + description; open → closed (the admin, with a note the
--                   customer sees). At most one OPEN claim per order. The carrier never sees claims (D138, MVP).
--                   Stage 6: an open claim puts the payout on hold.
--   * claim_photos  up to 5 JPEG photos per claim, files in the private bucket claim-photos ({claim_id}/{uuid}.jpg),
--                   compressed by the browser like the job photos (D130).
-- Rows are written only by functions:
--   open_claim()            customer session — own order, delivered / completed, within 14 days of delivered_at;
--   register_claim_photo()  customer session — after the browser uploaded the file (checks the object in Storage);
--   admin_close_claim()     service role, admin checked in the database, audit in the same transaction (no free text).
-- Customer reads with its session (RLS: own claims), the admin reads everything.

create type public.claim_category as enum ('damaged_goods', 'missing_goods', 'delay', 'carrier_behaviour', 'other');
create type public.claim_status as enum ('open', 'closed');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.claims (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders (id) on delete restrict,
  customer_id     uuid not null,                 -- the order's customer when opened (no FK, like order_status_history)
  category        public.claim_category not null,
  description     text not null check (length(trim(description)) between 10 and 4000),
  status          public.claim_status not null default 'open',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  closed_at       timestamptz,
  closed_by       uuid,                          -- admin (no FK)
  resolution_note text check (resolution_note is null or length(trim(resolution_note)) between 1 and 4000),
  check ((status = 'closed') = (closed_at is not null)),
  check (status = 'open' or resolution_note is not null)
);
create index claims_order_idx on public.claims (order_id);
create index claims_status_idx on public.claims (status, created_at);
create unique index claims_one_open_per_order on public.claims (order_id) where status = 'open';

create trigger claims_a_forbid_changes
  before update on public.claims
  for each row execute function public.forbid_column_changes('id', 'order_id', 'customer_id', 'category', 'description', 'created_at');
create trigger claims_set_updated_at
  before update on public.claims
  for each row execute function public.set_updated_at();

create table public.claim_photos (
  id           uuid primary key default gen_random_uuid(),
  claim_id     uuid not null references public.claims (id) on delete cascade,
  storage_path text not null unique,             -- claim-photos bucket: {claim_id}/{uuid}.jpg
  size_bytes   integer not null check (size_bytes between 1 and 5242880),
  uploaded_by  uuid not null,
  created_at   timestamptz not null default now(),
  check (storage_path like claim_id::text || '/%.jpg')
);
create index claim_photos_claim_idx on public.claim_photos (claim_id);

create trigger claim_photos_no_update
  before update on public.claim_photos
  for each row execute function public.reject_change();

-- ---------------------------------------------------------------------------
-- Privileges + RLS: read only; every write through the functions below.
-- ---------------------------------------------------------------------------
revoke all on public.claims, public.claim_photos from anon, authenticated, service_role;
grant select on public.claims, public.claim_photos to authenticated, service_role;

alter table public.claims enable row level security;
alter table public.claim_photos enable row level security;

create policy claims_select_customer on public.claims
  for select to authenticated
  using (customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente');
create policy claims_select_admin on public.claims
  for select to authenticated
  using ((select public.is_admin()));

create policy claim_photos_select_customer on public.claim_photos
  for select to authenticated
  using (exists (
    select 1 from public.claims c
    where c.id = claim_photos.claim_id and c.customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente'
  ));
create policy claim_photos_select_admin on public.claim_photos
  for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Storage: private bucket. Upload by the customer into the folder of its OPEN claim; no update / delete.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('claim-photos', 'claim-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

create policy claim_photos_storage_insert_customer on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'claim-photos'
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
    and (select public.auth_role()) = 'cliente'
    and exists (
      select 1 from public.claims c
      where c.id::text = (storage.foldername(name))[1] and c.customer_id = (select auth.uid()) and c.status = 'open'
    )
  );

-- The customer: own uploads in its claims' folders (needed by the upload) and the registered photos (RLS of
-- claim_photos decides); the admin: everything in the bucket.
create policy claim_photos_storage_select_customer on storage.objects
  for select to authenticated
  using (
    bucket_id = 'claim-photos' and (select public.auth_role()) = 'cliente'
    and (
      exists (select 1 from public.claim_photos p where p.storage_path = name)
      or (owner_id = (select auth.uid())::text and exists (
        select 1 from public.claims c where c.id::text = (storage.foldername(name))[1] and c.customer_id = (select auth.uid())
      ))
    )
  );
create policy claim_photos_storage_select_admin on storage.objects
  for select to authenticated
  using (bucket_id = 'claim-photos' and (select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Internal: the signed-in, not blocked customer, or 42501.
-- ---------------------------------------------------------------------------
create function public.require_customer()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.auth_role() is distinct from 'cliente' then
    raise exception 'not a customer' using errcode = '42501', detail = 'not_customer';
  end if;
  return auth.uid();
end;
$$;
revoke execute on function public.require_customer() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- open_claim(order, category, description) — customer session.
-- An open claim of the same order already exists → that claim, newly_opened = false (double click / two tabs).
-- Errors: 42501 | 22023 order / category / description | 55000 not_delivered | too_late
-- ---------------------------------------------------------------------------
create function public.open_claim(p_order_id uuid, p_category public.claim_category, p_description text)
returns table (claim_id uuid, newly_opened boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c_window constant interval := interval '14 days';     -- D138
  v_me     uuid := public.require_customer();
  v_desc   text := trim(coalesce(p_description, ''));
  v_order  public.orders%rowtype;
  v_claim  public.claims%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.customer_id is distinct from v_me then
    raise exception 'open_claim: order not found' using errcode = '22023', detail = 'order';
  end if;

  select * into v_claim from public.claims where order_id = p_order_id and status = 'open';
  if found then
    return query select v_claim.id, false;
    return;
  end if;

  if p_category is null then
    raise exception 'open_claim: category required' using errcode = '22023', detail = 'category';
  end if;
  if length(v_desc) not between 10 and 4000 then
    raise exception 'open_claim: description must have 10–4000 characters' using errcode = '22023', detail = 'description';
  end if;
  if v_order.status not in ('delivered', 'completed') or v_order.delivered_at is null then
    raise exception 'open_claim: order not delivered' using errcode = '55000', detail = 'not_delivered';
  end if;
  if now() > v_order.delivered_at + c_window then
    raise exception 'open_claim: more than 14 days after the delivery' using errcode = '55000', detail = 'too_late';
  end if;

  insert into public.claims (order_id, customer_id, category, description)
  values (p_order_id, v_me, p_category, v_desc)
  returning * into v_claim;
  return query select v_claim.id, true;
end;
$$;
revoke execute on function public.open_claim(uuid, public.claim_category, text) from public, anon;
grant execute on function public.open_claim(uuid, public.claim_category, text) to authenticated;

-- ---------------------------------------------------------------------------
-- register_claim_photo(claim, path) — customer session, after the browser uploaded the file to claim-photos.
-- Checks the object (exists, uploaded by this customer, image/jpeg, ≤ 5 MB); max 5 photos per claim; only while
-- the claim is open. The same path again ("Riprova" after a lost response) → the existing row, newly = false.
-- Errors: 42501 | 22023 claim / path / file | 55000 closed | too_many_photos
-- ---------------------------------------------------------------------------
create function public.register_claim_photo(p_claim_id uuid, p_storage_path text)
returns table (photo_id uuid, newly_registered boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c_max   constant integer := 5;                         -- D138
  v_me    uuid := public.require_customer();
  v_claim public.claims%rowtype;
  v_photo public.claim_photos%rowtype;
  v_obj   record;
  v_size  bigint;
begin
  select * into v_claim from public.claims where id = p_claim_id for update;
  if not found or v_claim.customer_id is distinct from v_me then
    raise exception 'register_claim_photo: claim not found' using errcode = '22023', detail = 'claim';
  end if;

  select * into v_photo from public.claim_photos where storage_path = p_storage_path;
  if found then
    if v_photo.claim_id = p_claim_id and v_photo.uploaded_by = v_me then
      return query select v_photo.id, false;
      return;
    end if;
    raise exception 'register_claim_photo: path already used' using errcode = '22023', detail = 'path';
  end if;

  if v_claim.status <> 'open' then
    raise exception 'register_claim_photo: claim closed' using errcode = '55000', detail = 'closed';
  end if;
  if p_storage_path is null or p_storage_path !~ ('^' || p_claim_id::text || '/[0-9a-f-]{36}\.jpg$') then
    raise exception 'register_claim_photo: bad path' using errcode = '22023', detail = 'path';
  end if;

  select o.owner_id, o.metadata into v_obj
  from storage.objects o
  where o.bucket_id = 'claim-photos' and o.name = p_storage_path and o.archived_at is null and not o.is_delete_marker;
  v_size := nullif(v_obj.metadata ->> 'size', '')::bigint;
  if v_obj is null or v_obj.owner_id is distinct from v_me::text
     or v_obj.metadata ->> 'mimetype' is distinct from 'image/jpeg'
     or v_size is null or v_size not between 1 and 5242880 then
    raise exception 'register_claim_photo: file missing or not valid' using errcode = '22023', detail = 'file';
  end if;

  if (select count(*) from public.claim_photos where claim_id = p_claim_id) >= c_max then
    raise exception 'register_claim_photo: too many photos' using errcode = '55000', detail = 'too_many_photos';
  end if;

  insert into public.claim_photos (claim_id, storage_path, size_bytes, uploaded_by)
  values (p_claim_id, p_storage_path, v_size, v_me)
  returning * into v_photo;
  return query select v_photo.id, true;
end;
$$;
revoke execute on function public.register_claim_photo(uuid, text) from public, anon;
grant execute on function public.register_claim_photo(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_close_claim(claim, admin, note) — service role (the Server Action checks the admin session first).
-- The note is shown to the customer; the audit keeps only ids (no free text, CLAUDE.md). Already closed → false.
-- Errors: 42501 (not an active admin) | 22023 claim / note
-- ---------------------------------------------------------------------------
create function public.admin_close_claim(p_claim_id uuid, p_admin_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := public.require_admin(p_admin_id);
  v_note  text := trim(coalesce(p_note, ''));
  v_claim public.claims%rowtype;
begin
  if length(v_note) not between 1 and 4000 then
    raise exception 'admin_close_claim: note required' using errcode = '22023', detail = 'note';
  end if;
  select * into v_claim from public.claims where id = p_claim_id for update;
  if not found then
    raise exception 'admin_close_claim: claim not found' using errcode = '22023', detail = 'claim';
  end if;
  if v_claim.status = 'closed' then
    return false;
  end if;
  update public.claims set status = 'closed', closed_at = now(), closed_by = p_admin_id, resolution_note = v_note where id = p_claim_id;
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'claim.closed', 'claim', p_claim_id, jsonb_build_object('order_id', v_claim.order_id));
  return true;
end;
$$;
revoke execute on function public.admin_close_claim(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_close_claim(uuid, uuid, text) to service_role;
