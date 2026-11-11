-- Three services, step 6a: Facchinaggio dispatch (D152, D164–D168).
--   * Porter jobs go to carriers with offers_porters and porters_team_size >= persons — WITHOUT a vehicle
--     (orders.carrier_vehicle_id stays null; no CHECK or trigger requires a vehicle when assigned).
--   * Separate functions for porters; the transport ones keep their signatures and return types:
--       list_available_porter_jobs(order?)          carrier session  — anonymised card (no street, contacts, notes)
--       accept_porter_job(order)                    carrier session  — atomic, one winner (55000 already_taken)
--       admin_porter_candidates(order, admin)       service role     — who can take the order now
--       admin_assign_porter_job(order, carrier, admin) service role  — paid → assigned + audit
--       admin_set_carrier_porters(carrier, admin, offers, team) service role — + audit, counts of jobs in progress
--   * vehicle_fits_order(): explicit "transport only" — porters / storage orders never match a vehicle, so
--     list_available_jobs, accept_job, admin_job_candidates, admin_assign_job and admin_assign_handover stay
--     transport-only by an explicit rule (before: only because vehicle_type_id is null).
--   * admin_advance_order(): porters go assigned → picked_up ("Lavoro iniziato") → delivered ("Lavoro concluso"),
--     never in_transit; transport cannot skip in_transit (unchanged). D123 unchanged: "Lavoro concluso" by the
--     admin = without POD, reason required.
--   * Carrier execution functions stay transport-only without changes: carrier_record_step needs an order_legs row
--     (porters have none → 22023 'leg'); complete_delivery needs status in_transit (porters never reach it).
--   * admin_unassign_job: porters in 'assigned' → back to 'paid' (as transport); after "Lavoro iniziato" → 55000
--     'work_started', nothing changes (without this, order_onboard_leg() treats a picked_up order without steps as
--     load on board of leg 0 → "da gestire", which only a vehicle can take over — the order would be stuck).
--   * worked_minutes stays null (D166); nothing here reads it. Payouts do not exist yet (Stage 6).
-- Every function with p_admin_id: EXECUTE only for service_role (revoked from public, anon, authenticated).

-- ---------------------------------------------------------------------------
-- vehicle_fits_order: + transport only (rest unchanged from 20261110100000_carrier_jobs.sql)
-- ---------------------------------------------------------------------------
create or replace function public.vehicle_fits_order(p_vehicle_id uuid, p_order_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rank_ok boolean;
  v_payload integer;
  v_cargo   integer[];
  v_pallets smallint;
  v_item    integer[];
  o         public.orders%rowtype;
  i         integer;
begin
  select * into o from public.orders where id = p_order_id;
  if not found or o.service_type <> 'transport' then   -- porters / storage: no vehicle dispatch (D152, D164)
    return false;
  end if;

  select vt.size_rank >= ot.size_rank,
         coalesce(cv.payload_kg, vt.payload_kg),
         case when cv.cargo_length_cm is not null and cv.cargo_width_cm is not null and cv.cargo_height_cm is not null
              then array[cv.cargo_length_cm, cv.cargo_width_cm, cv.cargo_height_cm]
              when vt.cargo_length_cm is not null and vt.cargo_width_cm is not null and vt.cargo_height_cm is not null
              then array[vt.cargo_length_cm, vt.cargo_width_cm, vt.cargo_height_cm]
         end,
         vt.euro_pallets
    into v_rank_ok, v_payload, v_cargo, v_pallets
  from public.carrier_vehicles cv
  join public.vehicle_types vt on vt.id = cv.vehicle_type_id
  join public.vehicle_types ot on ot.id = o.vehicle_type_id
  where cv.id = p_vehicle_id;
  if not found or not v_rank_ok then
    return false;
  end if;

  if o.weight_kg is not null and v_payload is not null and o.weight_kg > v_payload then
    return false;
  end if;
  if o.pallets_count is not null and v_pallets is not null and o.pallets_count > v_pallets then
    return false;
  end if;

  select coalesce(array_agg(x order by x desc), '{}') into v_item
  from unnest(array[o.largest_item_length_cm, o.largest_item_width_cm, o.largest_item_height_cm]) x
  where x is not null and x > 0;
  if cardinality(v_item) > 0 and v_cargo is not null then
    select array_agg(x order by x desc) into v_cargo from unnest(v_cargo) x;
    for i in 1 .. cardinality(v_item) loop
      if v_item[i] > v_cargo[i] then
        return false;
      end if;
    end loop;
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Internal: the carrier's team can do this porter job (D152): offers_porters and team >= persons.
-- Status and documents are checked separately (carrier_job_blockers).
-- ---------------------------------------------------------------------------
create function public.carrier_fits_porter_job(p_carrier_id uuid, p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.carriers c
    join public.order_porter_jobs j on j.order_id = p_order_id
    where c.profile_id = p_carrier_id and c.offers_porters and c.porters_team_size >= j.persons
  );
$$;
revoke execute on function public.carrier_fits_porter_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.carrier_fits_porter_job(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- list_available_porter_jobs(p_order_id): porter jobs in "Corse disponibili" (one when p_order_id is given)
-- Active carrier without blockers (else 42501, detail = blocker codes, as list_available_jobs); a carrier without
-- offers_porters gets an empty list. Paid, unassigned, starting in the future, team big enough.
-- NO personal data (D119): no street, postal code, coordinates, place id, contact, goods description, notes.
-- The amount is the carrier's own (order_porter_carrier_terms, D29) — never the customer price.
-- ---------------------------------------------------------------------------
create function public.list_available_porter_jobs(p_order_id uuid default null)
returns table (
  order_id             uuid,
  order_number         text,
  city                 text,
  province             char(2),
  job_date             date,
  window_start         timestamptz,
  window_end           timestamptz,
  persons              smallint,
  requested_hours      smallint,
  billed_hours         smallint,
  floor                smallint,
  has_elevator         boolean,
  is_urgent            boolean,
  carrier_amount_cents integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me       uuid := public.require_carrier();
  v_blockers text[] := public.carrier_job_blockers(v_me);
begin
  if cardinality(v_blockers) > 0 then
    raise exception 'list_available_porter_jobs: not eligible' using errcode = '42501', detail = array_to_string(v_blockers, ',');
  end if;

  return query
  select o.id, o.order_number, j.city, j.province, j.job_date, j.window_start, j.window_end,
         j.persons, j.requested_hours, j.billed_hours, j.floor, j.has_elevator, j.is_urgent,
         t.carrier_amount_cents
  from public.orders o
  join public.order_porter_jobs j on j.order_id = o.id
  join public.order_porter_carrier_terms t on t.order_id = o.id
  where o.service_type = 'porters' and o.status = 'paid' and o.carrier_id is null and o.pickup_window_start > now()
    and (p_order_id is null or o.id = p_order_id)
    and public.carrier_fits_porter_job(v_me, o.id)
  order by o.pickup_window_start, o.order_number;
end;
$$;
revoke execute on function public.list_available_porter_jobs(uuid) from public, anon;
grant execute on function public.list_available_porter_jobs(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- accept_porter_job(order): "Accetta la Corsa" for Facchinaggio — no vehicle (D164)
-- Same pattern as accept_job: carrier row FOR SHARE (a parallel admin_set_carrier_porters / suspension waits),
-- order row FOR UPDATE (one winner; the others 55000 already_taken); the same carrier again → newly_assigned false.
-- Errors: 42501 not eligible (detail = blocker codes) | 22023 order not found / not a porter job
--         55000 already_taken | not_available | too_late | team_not_suitable
-- ---------------------------------------------------------------------------
create function public.accept_porter_job(p_order_id uuid)
returns table (assigned_at timestamptz, newly_assigned boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me       uuid := public.require_carrier();
  v_blockers text[];
  v_order    public.orders%rowtype;
  v_now      timestamptz := now();
begin
  perform 1 from public.carriers where profile_id = v_me for share;
  v_blockers := public.carrier_job_blockers(v_me);
  if cardinality(v_blockers) > 0 then
    raise exception 'accept_porter_job: not eligible' using errcode = '42501', detail = array_to_string(v_blockers, ',');
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.service_type <> 'porters' then
    raise exception 'accept_porter_job: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.carrier_id = v_me and v_order.status = 'assigned' then
    return query select v_order.assigned_at, false;
    return;
  end if;
  if v_order.carrier_id is not null then
    raise exception 'accept_porter_job: already taken' using errcode = '55000', detail = 'already_taken';
  end if;
  if v_order.status <> 'paid' then
    raise exception 'accept_porter_job: not available' using errcode = '55000', detail = 'not_available';
  end if;
  if v_order.pickup_window_start <= v_now then
    raise exception 'accept_porter_job: window started' using errcode = '55000', detail = 'too_late';
  end if;
  if not public.carrier_fits_porter_job(v_me, p_order_id) then
    raise exception 'accept_porter_job: team not suitable' using errcode = '55000', detail = 'team_not_suitable';
  end if;

  update public.orders
     set status = 'assigned', carrier_id = v_me, carrier_vehicle_id = null, assigned_at = v_now
   where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
  values (p_order_id, 'paid', 'assigned', v_me, 'carrier_app');

  return query select v_now, true;
end;
$$;
revoke execute on function public.accept_porter_job(uuid) from public, anon;
grant execute on function public.accept_porter_job(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_porter_candidates(order, admin): carriers who can take the porter job now (D152, D122)
-- Empty when the order is not a paid, unassigned porter job starting in the future.
-- ---------------------------------------------------------------------------
create function public.admin_porter_candidates(p_order_id uuid, p_admin_id uuid)
returns table (carrier_id uuid, company_name text, porters_team_size smallint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.require_admin(p_admin_id);
  return query
  select c.profile_id, c.company_name, c.porters_team_size
  from public.orders o
  join public.carriers c on c.status = 'active' and c.offers_porters
  where o.id = p_order_id and o.service_type = 'porters' and o.status = 'paid' and o.carrier_id is null
    and o.pickup_window_start > now()
    and public.carrier_fits_porter_job(c.profile_id, o.id)
    and cardinality(public.carrier_job_blockers(c.profile_id)) = 0
  order by c.company_name;
end;
$$;
revoke execute on function public.admin_porter_candidates(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_porter_candidates(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- admin_assign_porter_job(order, carrier, admin): paid → assigned, same checks as accept_porter_job.
-- Errors: 42501 not an admin | 22023 order / carrier not found
--         55000 already_taken | not_available | too_late | carrier_not_eligible:<codes> | team_not_suitable
-- ---------------------------------------------------------------------------
create function public.admin_assign_porter_job(p_order_id uuid, p_carrier_id uuid, p_admin_id uuid)
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
    raise exception 'admin_assign_porter_job: carrier not found' using errcode = '22023', detail = 'carrier';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.service_type <> 'porters' then
    raise exception 'admin_assign_porter_job: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.carrier_id is not null then
    raise exception 'admin_assign_porter_job: already taken' using errcode = '55000', detail = 'already_taken';
  end if;
  if v_order.status <> 'paid' then
    raise exception 'admin_assign_porter_job: not available' using errcode = '55000', detail = 'not_available';
  end if;
  if v_order.pickup_window_start <= v_now then
    raise exception 'admin_assign_porter_job: window started' using errcode = '55000', detail = 'too_late';
  end if;
  v_blockers := public.carrier_job_blockers(p_carrier_id);
  if cardinality(v_blockers) > 0 then
    raise exception 'admin_assign_porter_job: carrier not eligible' using errcode = '55000',
      detail = 'carrier_not_eligible:' || array_to_string(v_blockers, ',');
  end if;
  if not public.carrier_fits_porter_job(p_carrier_id, p_order_id) then
    raise exception 'admin_assign_porter_job: team not suitable' using errcode = '55000', detail = 'team_not_suitable';
  end if;

  update public.orders
     set status = 'assigned', carrier_id = p_carrier_id, carrier_vehicle_id = null, assigned_at = v_now
   where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
  values (p_order_id, 'paid', 'assigned', p_admin_id, 'admin_panel');
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.assigned', 'order', p_order_id,
          jsonb_build_object('carrier_id', p_carrier_id, 'vehicle_id', null, 'service_type', 'porters'));
  return v_now;
end;
$$;
revoke execute on function public.admin_assign_porter_job(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_assign_porter_job(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- admin_set_carrier_porters(carrier, admin, offers, team_size) (D152, D167)
-- offers = true → team 2–4; offers = false → team must be null. Any carrier status (the admin may prepare it
-- before activation). Jobs already assigned stay with the carrier (as D116); the change applies to new jobs.
-- Returns the carrier's porter jobs in progress (assigned / picked_up) and how many of them now have a team
-- smaller than the persons of the job ("Squadra insufficiente" in /admin/ordini, computed there from the same data).
-- Audit: carrier.porters_updated with old and new values (no personal data). No change → no audit row.
-- Errors: 42501 | 22023 carrier / team
-- ---------------------------------------------------------------------------
create function public.admin_set_carrier_porters(
  p_carrier_id uuid, p_admin_id uuid, p_offers boolean, p_team_size smallint
)
returns table (jobs_in_progress integer, jobs_team_too_small integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email text := public.require_admin(p_admin_id);
  v_old   public.carriers%rowtype;
begin
  if p_offers is null or (p_offers and (p_team_size is null or p_team_size not between 2 and 4))
     or (not p_offers and p_team_size is not null) then
    raise exception 'admin_set_carrier_porters: invalid team' using errcode = '22023', detail = 'team';
  end if;
  select * into v_old from public.carriers where profile_id = p_carrier_id for update;
  if not found then
    raise exception 'admin_set_carrier_porters: carrier not found' using errcode = '22023', detail = 'carrier';
  end if;

  if v_old.offers_porters is distinct from p_offers or v_old.porters_team_size is distinct from p_team_size then
    update public.carriers set offers_porters = p_offers, porters_team_size = p_team_size where profile_id = p_carrier_id;
    insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
    values (p_admin_id, v_email, 'carrier.porters_updated', 'carrier', p_carrier_id,
            jsonb_build_object('from', jsonb_build_object('offers_porters', v_old.offers_porters, 'porters_team_size', v_old.porters_team_size),
                               'to', jsonb_build_object('offers_porters', p_offers, 'porters_team_size', p_team_size)));
  end if;

  return query
  select count(*)::integer,
         count(*) filter (where not p_offers or p_team_size < j.persons)::integer
  from public.orders o
  join public.order_porter_jobs j on j.order_id = o.id
  where o.carrier_id = p_carrier_id and o.service_type = 'porters' and o.status in ('assigned', 'picked_up');
end;
$$;
revoke execute on function public.admin_set_carrier_porters(uuid, uuid, boolean, smallint) from public, anon, authenticated;
grant execute on function public.admin_set_carrier_porters(uuid, uuid, boolean, smallint) to service_role;

-- ---------------------------------------------------------------------------
-- admin_advance_order: next status depends on the service (D165). Signature, errors and D123 unchanged:
--   transport: assigned → picked_up → in_transit → delivered
--   porters:   assigned → picked_up ("Lavoro iniziato") → delivered ("Lavoro concluso")
--   storage:   never (no carrier) → 55000 not_next_status
-- ---------------------------------------------------------------------------
create or replace function public.admin_advance_order(
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
  v_next := case
              when v_order.service_type = 'transport' then
                case v_order.status
                  when 'assigned' then 'picked_up'::public.order_status
                  when 'picked_up' then 'in_transit'::public.order_status
                  when 'in_transit' then 'delivered'::public.order_status
                end
              when v_order.service_type = 'porters' then
                case v_order.status
                  when 'assigned' then 'picked_up'::public.order_status
                  when 'picked_up' then 'delivered'::public.order_status
                end
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
  if v_note is not null then
    insert into public.order_admin_notes (order_id, kind, body, created_by)
    values (p_order_id, case when p_to_status = 'delivered' then 'delivered_without_pod' else 'status_changed' end, v_note, p_admin_id);
  end if;
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.status_changed', 'order', p_order_id,
          jsonb_build_object('from', v_order.status, 'to', p_to_status)
          || case when p_to_status = 'delivered' then jsonb_build_object('pod', false) else '{}'::jsonb end);
  return p_to_status;
end;
$$;
-- (create or replace keeps the grants: service_role only, as in 20261111100000_carrier_job_execution.sql)

-- ---------------------------------------------------------------------------
-- admin_unassign_job: + porters after "Lavoro iniziato" → 55000 'work_started' (rest unchanged from
-- 20261111130000_handover_warehouse_revert_guard.sql). Errors: 22023 reason / order | 55000 not_assigned |
-- work_started | all_unloaded
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
  v_kind    text;
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
  -- porters (D165): no load and no handover — once the work has started the admin closes it ("Lavoro concluso")
  if v_order.service_type = 'porters' and v_order.status <> 'assigned' then
    raise exception 'admin_unassign_job: porter work already started' using errcode = '55000', detail = 'work_started';
  end if;

  -- decided BEFORE the update: the carrier-change trigger reverts the steps of unfinished legs
  if public.order_onboard_leg(p_order_id) is not null then
    v_leg := public.order_onboard_leg(p_order_id);
    v_kind := 'on_board';
  elsif v_order.status in ('picked_up', 'in_transit') then
    v_leg := public.order_handover_leg(p_order_id);
    if v_leg is null then
      raise exception 'admin_unassign_job: every leg unloaded, delivery not confirmed' using errcode = '55000', detail = 'all_unloaded';
    end if;
    v_kind := 'in_warehouse';
  end if;

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
                             'reason_code', p_reason_code, 'from', v_order.status, 'goods_loaded', coalesce(v_kind = 'on_board', false),
                             'handover_leg_index', v_leg, 'handover_reason', v_kind,
                             'pickup_window_passed', v_order.pickup_window_start <= now()));
end;
$$;
-- (create or replace keeps the grants: service_role only)
