-- Admin dispatch, minimal version while the carrier PWA is postponed (D122, D123):
--   * admin_job_candidates()  carriers + vehicles that may take a paid order — the SAME rules as accept_job (D120),
--                             no override;
--   * admin_assign_job()      paid → assigned (row lock: a parallel accept_job or a second admin cannot both win);
--   * admin_unassign_job()    assigned → paid ("Rimuovi padroncino", D39), reason as a code, audit only;
--   * admin_advance_order()   one step forward only: assigned → picked_up → in_transit → delivered;
--                             delivered by the admin = WITHOUT proof of delivery: orders.delivered_without_pod = true,
--                             such an order never goes to an automatic payout (Stage 6 must check it).
-- Lock order (no deadlock with accept_job / release_job): admin_assign_job takes the SAME order as accept_job —
-- carriers row FOR SHARE → carrier_vehicles row FOR SHARE → orders row FOR UPDATE; the other functions lock only
-- the orders row. The foreign keys of the UPDATE (carrier_id, carrier_vehicle_id) need KEY SHARE on rows already held.
-- All: service role only; p_admin_id from the admin's session, checked here (active admin); status history
-- (source admin_panel, changed_by admin) and audit_log in the same transaction — ids and statuses only (D65).
-- No RLS policy changes.

-- ---------------------------------------------------------------------------
-- orders.delivered_without_pod (D123)
-- Set only by admin_advance_order(); never cleared. The carrier app (signature + photo) will deliver with POD.
-- ---------------------------------------------------------------------------
alter table public.orders add column delivered_without_pod boolean not null default false;

-- Once true, never false again — for every role (service role and SQL Editor included), no session flag.
create or replace function public.guard_delivered_without_pod()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.delivered_without_pod and not new.delivered_without_pod then
    raise exception 'orders.delivered_without_pod cannot go back to false (order %)', old.id
      using errcode = '23514', detail = 'delivered_without_pod';
  end if;
  return new;
end;
$$;

create trigger orders_c_guard_delivered_without_pod
  before update on public.orders
  for each row execute function public.guard_delivered_without_pod();

-- ---------------------------------------------------------------------------
-- Internal: the active admin's e-mail, or 42501.
-- ---------------------------------------------------------------------------
create or replace function public.require_admin(p_admin_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  select p.email into v_email from public.profiles p where p.id = p_admin_id and p.role = 'admin' and not p.is_blocked;
  if not found then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  return v_email;
end;
$$;
revoke execute on function public.require_admin(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- admin_job_candidates(order, admin): who can take the order now (D120 rules, D122).
-- Empty when the order is not paid / already assigned / pickup started.
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
  where o.id = p_order_id and o.status = 'paid' and o.carrier_id is null and o.pickup_window_start > now()
    and cardinality(public.carrier_job_blockers(c.profile_id)) = 0
    and public.carrier_vehicle_job_ready(v.id)
    and public.vehicle_fits_order(v.id, o.id)
  order by c.company_name, vt.size_rank, v.plate;
end;
$$;
revoke execute on function public.admin_job_candidates(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_job_candidates(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- admin_assign_job(order, carrier, vehicle, admin): paid → assigned, same checks as accept_job (D120).
-- Errors: 42501 not an admin | 22023 order / vehicle not found or not the carrier's
--         55000 already_taken | not_available | too_late | carrier_not_eligible (detail: blocker codes after ':')
--               | vehicle_not_ready | vehicle_not_suitable
-- ---------------------------------------------------------------------------
create or replace function public.admin_assign_job(p_order_id uuid, p_carrier_id uuid, p_vehicle_id uuid, p_admin_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email    text := public.require_admin(p_admin_id);
  v_blockers text[];
  v_order    public.orders%rowtype;
  v_now      timestamptz := now();
begin
  perform 1 from public.carriers where profile_id = p_carrier_id for share;
  if not found then
    raise exception 'admin_assign_job: carrier not found' using errcode = '22023', detail = 'carrier';
  end if;
  perform 1 from public.carrier_vehicles where id = p_vehicle_id and carrier_id = p_carrier_id for share;
  if not found then
    raise exception 'admin_assign_job: vehicle not found' using errcode = '22023', detail = 'vehicle';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'admin_assign_job: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.carrier_id is not null then
    raise exception 'admin_assign_job: already taken' using errcode = '55000', detail = 'already_taken';
  end if;
  if v_order.status <> 'paid' then
    raise exception 'admin_assign_job: not available' using errcode = '55000', detail = 'not_available';
  end if;
  if v_order.pickup_window_start <= v_now then
    raise exception 'admin_assign_job: pickup window started' using errcode = '55000', detail = 'too_late';
  end if;
  v_blockers := public.carrier_job_blockers(p_carrier_id);
  if cardinality(v_blockers) > 0 then
    raise exception 'admin_assign_job: carrier not eligible' using errcode = '55000',
      detail = 'carrier_not_eligible:' || array_to_string(v_blockers, ',');
  end if;
  if not public.carrier_vehicle_job_ready(p_vehicle_id) then
    raise exception 'admin_assign_job: vehicle not ready' using errcode = '55000', detail = 'vehicle_not_ready';
  end if;
  if not public.vehicle_fits_order(p_vehicle_id, p_order_id) then
    raise exception 'admin_assign_job: vehicle not suitable' using errcode = '55000', detail = 'vehicle_not_suitable';
  end if;

  update public.orders
     set status = 'assigned', carrier_id = p_carrier_id, carrier_vehicle_id = p_vehicle_id, assigned_at = v_now
   where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
  values (p_order_id, 'paid', 'assigned', p_admin_id, 'admin_panel');
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.assigned', 'order', p_order_id,
          jsonb_build_object('carrier_id', p_carrier_id, 'vehicle_id', p_vehicle_id));
  return v_now;
end;
$$;
revoke execute on function public.admin_assign_job(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_assign_job(uuid, uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- admin_unassign_job(order, admin, reason_code): assigned → paid, back to the list (D39). Only in 'assigned'.
-- The reason is a CODE from a fixed list, written only to audit_log (no free text: the history note is visible
-- to the customer and the carrier, audit_log keeps no free text — D65):
--   errore_admin | richiesta_padroncino | problema_veicolo | padroncino_non_disponibile | altro
-- If the pickup window has already passed, the order is 'paid' with a past window: nobody can accept it — the
-- admin must reschedule or refund (TODO, Stage 6).
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
begin
  if p_reason_code is null or not p_reason_code = any (c_reasons) then
    raise exception 'admin_unassign_job: unknown reason code' using errcode = '22023', detail = 'reason';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'admin_unassign_job: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.status <> 'assigned' then
    raise exception 'admin_unassign_job: not assigned' using errcode = '55000', detail = 'not_assigned';
  end if;

  update public.orders
     set status = 'paid', carrier_id = null, carrier_vehicle_id = null, assigned_at = null
   where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
  values (p_order_id, 'assigned', 'paid', p_admin_id, 'admin_panel');
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.unassigned', 'order', p_order_id,
          jsonb_build_object('carrier_id', v_order.carrier_id, 'vehicle_id', v_order.carrier_vehicle_id,
                             'reason_code', p_reason_code,
                             'pickup_window_passed', v_order.pickup_window_start <= now()));
end;
$$;
revoke execute on function public.admin_unassign_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_unassign_job(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- admin_advance_order(order, admin, to_status): exactly one step forward
--   assigned → picked_up (picked_up_at) → in_transit (in_transit_at) → delivered (delivered_at)
-- delivered here = without proof of delivery (D123): delivered_without_pod = true, audit data pod = false.
-- Errors: 42501 | 22023 order / unknown target | 55000 not_next_status (detail = current status)
-- ---------------------------------------------------------------------------
create or replace function public.admin_advance_order(p_order_id uuid, p_admin_id uuid, p_to_status public.order_status)
returns public.order_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := public.require_admin(p_admin_id);
  v_order public.orders%rowtype;
  v_next  public.order_status;
  v_now   timestamptz := now();
begin
  if p_to_status is null or p_to_status not in ('picked_up', 'in_transit', 'delivered') then
    raise exception 'admin_advance_order: unknown target status' using errcode = '22023', detail = 'status';
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
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
  values (p_order_id, v_order.status, p_to_status, p_admin_id, 'admin_panel');
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.status_changed', 'order', p_order_id,
          jsonb_build_object('from', v_order.status, 'to', p_to_status)
          || case when p_to_status = 'delivered' then jsonb_build_object('pod', false) else '{}'::jsonb end);
  return p_to_status;
end;
$$;
revoke execute on function public.admin_advance_order(uuid, uuid, public.order_status) from public, anon, authenticated;
grant execute on function public.admin_advance_order(uuid, uuid, public.order_status) to service_role;
