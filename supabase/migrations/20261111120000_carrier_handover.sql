-- "Da gestire": the admin removed a carrier while the load was on board (owner 2026-11-11, D130).
--   * admin_unassign_job: load on board → the order KEEPS its status (picked_up / in_transit — the customer still
--     sees "Ritirato" / "In viaggio"), carrier_id = null, orders.handover_required_at / handover_leg_index set.
--     It is not 'paid', so it is never on the carriers' list, accept_job refuses it and admin_assign_job refuses it.
--     Before loading: unchanged (back to 'paid' and to the list).
--   * admin_assign_handover(): the admin assigns a carrier directly (same carrier/vehicle rules as accept_job, D120,
--     but no pickup window check), with the CURRENT address of the goods (order_handovers — the new carrier and
--     admins read it, the customer does not) and an internal reason (order_admin_notes 'handover').
--   * "Consegnato" without POD on a "da gestire" order: admin_advance_order as before (reason required); allowed
--     without a carrier only while the handover flag is set; no automatic payout (D123).
--   * carrier change: only the steps of legs NOT finished are reverted; finished legs (live 'unloaded') stay, and
--     the new carrier reads them (live steps of its order; reverted ones only since its assignment).
--   * carrier_record_step: 'loaded' / 'departed' move the status forward on ANY leg (a new carrier may start on leg 2).
--   * release_job: "load on board" = a leg loaded and not unloaded (a finished leg does not block).
-- Tests: tests/rls/carrier-handover.test.ts.

-- ---------------------------------------------------------------------------
-- orders: the handover flag
-- ---------------------------------------------------------------------------
alter table public.orders
  add column handover_required_at timestamptz,
  add column handover_leg_index smallint,
  add constraint orders_handover_flag_check check ((handover_required_at is null) = (handover_leg_index is null));

-- Running / delivered statuses need a carrier — except a "da gestire" order (flag set) in picked_up, in_transit
-- or delivered (Consegnato without POD by the admin).
do $$
declare
  v_name text;
begin
  select conname into v_name from pg_constraint
   where conrelid = 'public.orders'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%cancellation_review%' and pg_get_constraintdef(oid) like '%carrier_id IS NOT NULL%';
  if v_name is null then
    raise exception 'orders carrier check not found';
  end if;
  execute format('alter table public.orders drop constraint %I', v_name);
end;
$$;
alter table public.orders add constraint orders_carrier_required_check check (
  status not in ('assigned', 'picked_up', 'in_transit', 'delivered', 'completed', 'cancellation_review')
  or carrier_id is not null
  or (handover_required_at is not null and status in ('picked_up', 'in_transit', 'delivered'))
);

create index orders_handover_idx on public.orders (handover_required_at) where handover_required_at is not null;

-- ---------------------------------------------------------------------------
-- order_admin_notes: + kind 'handover'
-- ---------------------------------------------------------------------------
alter table public.order_admin_notes drop constraint order_admin_notes_kind_check;
alter table public.order_admin_notes add constraint order_admin_notes_kind_check
  check (kind in ('delivered_without_pod', 'status_changed', 'step_reverted', 'early_start', 'handover'));

-- ---------------------------------------------------------------------------
-- order_handovers — where the new carrier picks the goods up (address typed by the admin). Append-only.
-- Readable by the carrier it was written for (while assigned) and admins; NOT by the customer (it is usually
-- the previous carrier's place).
-- ---------------------------------------------------------------------------
create table public.order_handovers (
  id         bigint generated always as identity primary key,
  order_id   uuid not null,
  leg_index  smallint not null,
  address    text not null check (length(trim(address)) between 1 and 500),
  carrier_id uuid not null,                -- the carrier the goods are handed over to
  created_by uuid not null,                -- the admin
  created_at timestamptz not null default now(),
  foreign key (order_id, leg_index) references public.order_legs (order_id, leg_index) on delete cascade
);
create index order_handovers_order_idx on public.order_handovers (order_id, id);

create trigger order_handovers_append_only
  before update or delete on public.order_handovers
  for each row execute function public.reject_change();
create trigger order_handovers_no_truncate
  before truncate on public.order_handovers
  for each statement execute function public.reject_change();

revoke all on public.order_handovers from anon, authenticated, service_role;
grant select (id, order_id, leg_index, address, carrier_id, created_at) on public.order_handovers to authenticated;
grant select on public.order_handovers to service_role;
alter table public.order_handovers enable row level security;

create policy order_handovers_select_carrier on public.order_handovers
  for select to authenticated
  using (
    carrier_id = (select auth.uid())
    and exists (
      select 1 from public.orders o
      where o.id = order_handovers.order_id
        and o.carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino'
    )
  );
create policy order_handovers_select_admin on public.order_handovers
  for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Internal: the leg whose load is on board (loaded, not unloaded); for an order the admin moved to picked_up /
-- in_transit without any step, leg 0. Null = nothing on board.
-- ---------------------------------------------------------------------------
create function public.order_onboard_leg(p_order_id uuid)
returns smallint
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select min(s.leg_index) from public.order_leg_steps s
      where s.order_id = p_order_id and s.step = 'loaded' and s.reverted_at is null
        and not exists (select 1 from public.order_leg_steps u
                        where u.order_id = s.order_id and u.leg_index = s.leg_index and u.step = 'unloaded' and u.reverted_at is null)),
    (select 0::smallint from public.orders o
      where o.id = p_order_id and o.status in ('picked_up', 'in_transit')
        and not exists (select 1 from public.order_leg_steps x where x.order_id = o.id and x.reverted_at is null))
  );
$$;
revoke execute on function public.order_onboard_leg(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Carrier change: revert only the steps of legs that are not finished.
-- ---------------------------------------------------------------------------
create or replace function public.revert_steps_on_carrier_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.order_leg_steps s
     set reverted_at = now()
   where s.order_id = new.id and s.reverted_at is null
     and not exists (select 1 from public.order_leg_steps u
                     where u.order_id = s.order_id and u.leg_index = s.leg_index and u.step = 'unloaded' and u.reverted_at is null);
  return new;
end;
$$;

-- The carrier reads every LIVE step of its order (finished legs of a previous carrier included — times only) and
-- reverted steps only from its own assignment on.
drop policy order_leg_steps_select_carrier on public.order_leg_steps;
create policy order_leg_steps_select_carrier on public.order_leg_steps
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_leg_steps.order_id
      and o.carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino'
      and (order_leg_steps.reverted_at is null or order_leg_steps.created_at >= o.assigned_at)
  ));

-- ---------------------------------------------------------------------------
-- carrier_record_step: status forward on any leg (unchanged otherwise)
-- ---------------------------------------------------------------------------
create or replace function public.carrier_record_step(
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
     and v_leg.early_start_allowed_at is null
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

  v_target := case p_step
                when 'loaded' then 'picked_up'::public.order_status
                when 'departed' then 'in_transit'::public.order_status
              end;
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

-- ---------------------------------------------------------------------------
-- release_job: "load on board" = a leg loaded and not unloaded (or picked_up / in_transit). Otherwise unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.release_job(p_order_id uuid)
returns table (released_at timestamptz, order_number text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c_grace     constant interval := interval '15 minutes';
  c_min_ahead constant interval := interval '48 hours';
  v_me        uuid := public.require_carrier();
  v_order     public.orders%rowtype;
  v_now       timestamptz := now();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'release_job: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.carrier_id is distinct from v_me then
    raise exception 'release_job: not assigned to this carrier' using errcode = '55000', detail = 'not_assigned';
  end if;
  if v_order.status in ('picked_up', 'in_transit') or public.order_onboard_leg(p_order_id) is not null then
    raise exception 'release_job: the load is on board' using errcode = '55000', detail = 'loaded';
  end if;
  if v_order.status <> 'assigned' then
    raise exception 'release_job: not assigned to this carrier' using errcode = '55000', detail = 'not_assigned';
  end if;
  if not (v_now <= v_order.assigned_at + c_grace or v_order.pickup_window_start >= v_now + c_min_ahead) then
    raise exception 'release_job: too late' using errcode = '55000', detail = 'too_late';
  end if;

  update public.orders
     set status = 'paid', carrier_id = null, carrier_vehicle_id = null, assigned_at = null
   where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
  values (p_order_id, 'assigned', 'paid', v_me, 'carrier_app');

  return query select v_now, v_order.order_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_unassign_job ("Rimuovi padroncino"):
--   load on board → "da gestire": status kept, carrier removed, handover flag set, NO status history row (the
--     status does not change; the customer sees nothing), audit handover = true;
--   otherwise → 'paid' as before (back to the list).
-- Errors: 42501 | 22023 order / reason | 55000 not_assigned
-- ---------------------------------------------------------------------------
create or replace function public.admin_unassign_job(p_order_id uuid, p_admin_id uuid, p_reason_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_reasons constant text[] := array['errore_admin', 'richiesta_padroncino', 'problema_veicolo', 'padroncino_non_disponibile', 'altro'];
  v_email   text := public.require_admin(p_admin_id);
  v_order   public.orders%rowtype;
  v_leg     smallint;
begin
  if p_reason_code is null or not p_reason_code = any (c_reasons) then
    raise exception 'admin_unassign_job: unknown reason code' using errcode = '22023', detail = 'reason';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'admin_unassign_job: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.carrier_id is null or v_order.status not in ('assigned', 'picked_up', 'in_transit') then
    raise exception 'admin_unassign_job: not assigned' using errcode = '55000', detail = 'not_assigned';
  end if;
  v_leg := public.order_onboard_leg(p_order_id);

  if v_leg is not null then
    update public.orders
       set carrier_id = null, carrier_vehicle_id = null, assigned_at = null,
           handover_required_at = now(), handover_leg_index = v_leg
     where id = p_order_id;
  else
    update public.orders
       set status = 'paid', carrier_id = null, carrier_vehicle_id = null, assigned_at = null,
           picked_up_at = null, in_transit_at = null
     where id = p_order_id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
    values (p_order_id, v_order.status, 'paid', p_admin_id, 'admin_panel');
  end if;
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.unassigned', 'order', p_order_id,
          jsonb_build_object('carrier_id', v_order.carrier_id, 'vehicle_id', v_order.carrier_vehicle_id,
                             'reason_code', p_reason_code, 'from', v_order.status, 'goods_loaded', v_leg is not null,
                             'handover_leg_index', v_leg, 'pickup_window_passed', v_order.pickup_window_start <= now()));
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_job_candidates: also for a "da gestire" order (no pickup window check there). Same D120 rules.
-- ---------------------------------------------------------------------------
create or replace function public.admin_job_candidates(p_order_id uuid, p_admin_id uuid)
returns table (carrier_id uuid, company_name text, vehicle_id uuid, plate text, vehicle_type_name text, payload_kg integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.require_admin(p_admin_id);
  return query
  select c.profile_id, c.company_name, v.id, v.plate, vt.name_it, v.payload_kg
  from public.orders o
  join public.carriers c on c.status = 'active'
  join public.carrier_vehicles v on v.carrier_id = c.profile_id
  join public.vehicle_types vt on vt.id = v.vehicle_type_id
  where o.id = p_order_id and o.carrier_id is null
    and ((o.status = 'paid' and o.pickup_window_start > now())
      or (o.handover_required_at is not null and o.status in ('picked_up', 'in_transit')))
    and cardinality(public.carrier_job_blockers(c.profile_id)) = 0
    and public.carrier_vehicle_job_ready(v.id)
    and public.vehicle_fits_order(v.id, o.id)
  order by c.company_name, vt.size_rank, v.plate;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_assign_handover(order, carrier, vehicle, admin, address, reason): direct assignment of a "da gestire"
-- order. Same locks and carrier/vehicle checks as admin_assign_job (D120), no pickup window check. The status
-- stays (picked_up / in_transit); assigned_at = now (the new carrier's history starts here, D128); the handover
-- flag is cleared; order_handovers (address for the new carrier), order_admin_notes 'handover' (reason), audit
-- (ids only). The server then sends order_assigned to the customer (D129: new key per assignment).
-- Errors: 42501 | 22023 order / vehicle / carrier / address / reason | 55000 not_handover | carrier_not_eligible
--         | vehicle_not_ready | vehicle_not_suitable
-- ---------------------------------------------------------------------------
create function public.admin_assign_handover(
  p_order_id uuid, p_carrier_id uuid, p_vehicle_id uuid, p_admin_id uuid, p_address text, p_reason text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email    text := public.require_admin(p_admin_id);
  v_address  text := trim(coalesce(p_address, ''));
  v_reason   text := trim(coalesce(p_reason, ''));
  v_blockers text[];
  v_order    public.orders%rowtype;
  v_now      timestamptz := now();
begin
  if length(v_address) not between 1 and 500 then
    raise exception 'admin_assign_handover: address required' using errcode = '22023', detail = 'address';
  end if;
  if length(v_reason) not between 1 and 1000 then
    raise exception 'admin_assign_handover: reason required' using errcode = '22023', detail = 'reason';
  end if;
  perform 1 from public.carriers where profile_id = p_carrier_id for share;
  if not found then
    raise exception 'admin_assign_handover: carrier not found' using errcode = '22023', detail = 'carrier';
  end if;
  perform 1 from public.carrier_vehicles where id = p_vehicle_id and carrier_id = p_carrier_id for share;
  if not found then
    raise exception 'admin_assign_handover: vehicle not found' using errcode = '22023', detail = 'vehicle';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'admin_assign_handover: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.handover_required_at is null or v_order.carrier_id is not null or v_order.status not in ('picked_up', 'in_transit') then
    raise exception 'admin_assign_handover: not a handover order' using errcode = '55000', detail = 'not_handover';
  end if;
  v_blockers := public.carrier_job_blockers(p_carrier_id);
  if cardinality(v_blockers) > 0 then
    raise exception 'admin_assign_handover: carrier not eligible' using errcode = '55000',
      detail = 'carrier_not_eligible:' || array_to_string(v_blockers, ',');
  end if;
  if not public.carrier_vehicle_job_ready(p_vehicle_id) then
    raise exception 'admin_assign_handover: vehicle not ready' using errcode = '55000', detail = 'vehicle_not_ready';
  end if;
  if not public.vehicle_fits_order(p_vehicle_id, p_order_id) then
    raise exception 'admin_assign_handover: vehicle not suitable' using errcode = '55000', detail = 'vehicle_not_suitable';
  end if;

  update public.orders
     set carrier_id = p_carrier_id, carrier_vehicle_id = p_vehicle_id, assigned_at = v_now,
         handover_required_at = null, handover_leg_index = null
   where id = p_order_id;
  insert into public.order_handovers (order_id, leg_index, address, carrier_id, created_by, created_at)
  values (p_order_id, v_order.handover_leg_index, v_address, p_carrier_id, p_admin_id, v_now);
  insert into public.order_admin_notes (order_id, kind, leg_index, body, created_by, created_at)
  values (p_order_id, 'handover', v_order.handover_leg_index, v_reason, p_admin_id, v_now);
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.handover_assigned', 'order', p_order_id,
          jsonb_build_object('carrier_id', p_carrier_id, 'vehicle_id', p_vehicle_id, 'leg_index', v_order.handover_leg_index));
  return v_now;
end;
$$;
revoke execute on function public.admin_assign_handover(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_assign_handover(uuid, uuid, uuid, uuid, text, text) to service_role;
