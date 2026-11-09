-- Stage 4: available jobs for carriers and "Accetta la Corsa" (D21, D22, D29, D39, D87, D116–D121)
--   * carrier_job_blockers()        why a carrier may not see / accept new jobs (status, company documents);
--   * carrier_vehicle_job_ready()   vehicle active, approved, required vehicle documents approved and valid;
--   * vehicle_fits_order()          D22 + D87 (type rank, payload, largest item with rotation, EUR pallets);
--   * carrier_job_eligibility()     the signed-in carrier's blockers and ready vehicles (for the screens);
--   * list_available_jobs()         paid, unassigned, future jobs matching a ready vehicle — ONLY columns without
--                                   customer personal data (cities, dates, km, load, services, carrier amount);
--   * accept_job()                  atomic: one winner, the others get 55000 already_taken; double click is a no-op;
--   * release_job()                 "Rinuncia": within 15 min of accepting or ≥ 48 h before the pickup window;
--   * guard_vehicle_in_job          a vehicle on an assigned / ongoing job cannot be deactivated or change type or
--                                   payload (every role).
-- One carrier per order, both legs (D75 model A, D117). No RLS policy changes: after accepting, the carrier reads
-- the full order through the existing "assigned carrier" policies; the carrier still has no UPDATE on orders.
-- payouts_enabled (D21) is NOT checked yet — added in the Stripe Connect step (D118).

-- ---------------------------------------------------------------------------
-- Internal helpers (no EXECUTE for API roles; used inside SECURITY DEFINER functions)
-- ---------------------------------------------------------------------------

-- Blockers for new jobs (D21, D116): carriers.status must be active; required company documents must be
-- APPROVED and valid today (Europe/Rome) — stricter than D99, where a pending document counts.
-- Codes: 'carrier_not_active', 'document:<doc_type>'. Empty = may see and accept jobs.
create or replace function public.carrier_job_blockers(p_carrier_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today  date := (now() at time zone 'Europe/Rome')::date;
  v_status public.carrier_status;
  v_out    text[] := '{}';
begin
  select status into v_status from public.carriers where profile_id = p_carrier_id;
  if v_status is distinct from 'active' then
    return array['carrier_not_active'];
  end if;
  v_out := v_out || coalesce((
    select array_agg('document:' || t.doc_type::text order by t.sort_order)
    from public.carrier_document_types t
    where t.scope = 'carrier' and t.is_required
      and not exists (
        select 1 from public.carrier_documents d
        where d.carrier_id = p_carrier_id and d.vehicle_id is null and d.doc_type = t.doc_type
          and d.review_status = 'approved'
          and (t.expiry = 'none' or d.expires_at >= v_today)
      )
  ), '{}');
  return v_out;
end;
$$;

-- A vehicle can take jobs: active, approved (D107), every required vehicle document approved and valid today.
create or replace function public.carrier_vehicle_job_ready(p_vehicle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.carrier_vehicles v
    where v.id = p_vehicle_id and v.is_active and v.approved_at is not null
      and not exists (
        select 1 from public.carrier_document_types t
        where t.scope = 'vehicle' and t.is_required
          and not exists (
            select 1 from public.carrier_documents d
            where d.vehicle_id = v.id and d.carrier_id = v.carrier_id and d.doc_type = t.doc_type
              and d.review_status = 'approved'
              and (t.expiry = 'none' or d.expires_at >= (now() at time zone 'Europe/Rome')::date)
          )
      )
  );
$$;

-- D22 + D87: the carrier's vehicle can carry this order.
--   * type: size_rank of the vehicle's type >= size_rank of the order's type (the carrier sees its type and smaller);
--   * weight: order weight_kg <= vehicle payload_kg (the carrier's own value, else the type's);
--   * largest item, rotation allowed (as src/lib/booking/vehicle-fit.ts, D84): the given item dimensions, largest
--     first, must each fit the cargo dimensions, largest first; cargo = the carrier's own dimensions when all three
--     are set, else the type's;
--   * EUR pallets: order pallets_count <= euro_pallets of the vehicle's type.
-- A missing order value is not a requirement; a missing vehicle value is not checked (D85).
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
  if not found then
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

revoke execute on function public.carrier_job_blockers(uuid) from public, anon, authenticated;
revoke execute on function public.carrier_vehicle_job_ready(uuid) from public, anon, authenticated;
revoke execute on function public.vehicle_fits_order(uuid, uuid) from public, anon, authenticated;
grant execute on function public.carrier_job_blockers(uuid), public.carrier_vehicle_job_ready(uuid),
  public.vehicle_fits_order(uuid, uuid) to service_role;

-- The signed-in carrier (padroncino role, not blocked) or nothing. Raises 42501 otherwise.
create or replace function public.require_carrier()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.auth_role() is distinct from 'padroncino' then
    raise exception 'not a carrier' using errcode = '42501', detail = 'not_carrier';
  end if;
  return auth.uid();
end;
$$;
revoke execute on function public.require_carrier() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- carrier_job_eligibility(): for the carrier's screens — why no jobs, which vehicles can take them
-- ---------------------------------------------------------------------------
create or replace function public.carrier_job_eligibility()
returns table (blockers text[], ready_vehicle_ids uuid[])
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := public.require_carrier();
begin
  return query
  select public.carrier_job_blockers(v_me),
         coalesce((select array_agg(v.id order by v.created_at) from public.carrier_vehicles v
                   where v.carrier_id = v_me and public.carrier_vehicle_job_ready(v.id)), '{}');
end;
$$;
revoke execute on function public.carrier_job_eligibility() from public, anon;
grant execute on function public.carrier_job_eligibility() to authenticated;

-- ---------------------------------------------------------------------------
-- list_available_jobs(p_order_id): "Corse disponibili" (one job when p_order_id is given)
-- Only for an active carrier without blockers; otherwise 42501 with the blocker codes in DETAIL.
-- Returns NO personal data (D119): no street / house number, coordinates, place ids, contacts, goods description
-- or customer notes — those are free text or identify the customer. Cities, provinces, dates, windows, km, minutes,
-- floors and lifts, load, services and the carrier's own amount (D29: never the customer price).
-- ---------------------------------------------------------------------------
create or replace function public.list_available_jobs(p_order_id uuid default null)
returns table (
  order_id                uuid,
  order_number            text,
  vehicle_type_name       text,
  pickup_window_start     timestamptz,
  weight_kg               integer,
  largest_item_length_cm  integer,
  largest_item_width_cm   integer,
  largest_item_height_cm  integer,
  pallets_count           integer,
  items_count             integer,
  load_category           public.porter_package_code,
  packing_items_count     integer,
  storage_type            public.storage_type,
  storage_days            integer,
  carrier_amount_cents    integer,
  transport_carrier_cents integer,
  porters_carrier_cents   integer,
  packing_carrier_cents   integer,
  legs                    jsonb,
  matching_vehicle_ids    uuid[]
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
  v_ready    uuid[];
begin
  if cardinality(v_blockers) > 0 then
    raise exception 'list_available_jobs: not eligible' using errcode = '42501', detail = array_to_string(v_blockers, ',');
  end if;
  select coalesce(array_agg(v.id), '{}') into v_ready
  from public.carrier_vehicles v where v.carrier_id = v_me and public.carrier_vehicle_job_ready(v.id);

  return query
  with candidates as (
    select o.*,
           array(select vid from unnest(v_ready) vid where public.vehicle_fits_order(vid, o.id)) as fits
    from public.orders o
    where o.status = 'paid' and o.carrier_id is null and o.pickup_window_start > now()
      and (p_order_id is null or o.id = p_order_id)
  )
  select c.id, c.order_number, vt.name_it, c.pickup_window_start,
         c.weight_kg, c.largest_item_length_cm, c.largest_item_width_cm, c.largest_item_height_cm,
         c.pallets_count, c.items_count, c.load_category, c.packing_items_count, c.storage_type, c.storage_days,
         t.carrier_amount_cents::integer, t.transport_carrier_cents::integer, t.porters_carrier_cents::integer,
         t.packing_carrier_cents::integer,
         (select jsonb_agg(jsonb_build_object(
                   'leg_index', l.leg_index,
                   'pickup_city', l.pickup_city, 'pickup_province', l.pickup_province,
                   'pickup_is_warehouse', l.pickup_warehouse_id is not null,
                   'delivery_city', l.delivery_city, 'delivery_province', l.delivery_province,
                   'delivery_is_warehouse', l.delivery_warehouse_id is not null,
                   'distance_m', l.distance_m, 'duration_s', l.duration_s,
                   'pickup_date', l.pickup_date,
                   'pickup_window_start', l.pickup_window_start, 'pickup_window_end', l.pickup_window_end,
                   'pickup_floor', l.pickup_floor, 'pickup_has_elevator', l.pickup_has_elevator,
                   'delivery_floor', l.delivery_floor, 'delivery_has_elevator', l.delivery_has_elevator,
                   'is_urgent', l.is_urgent,
                   'porter_package_code', l.porter_package_code, 'porters_count', l.porters_count,
                   'porters_included_hours', l.porters_included_hours,
                   'carrier_amount_cents', lt.carrier_amount_cents
                 ) order by l.leg_index)
          from public.order_legs l
          left join public.order_leg_carrier_terms lt on lt.order_id = l.order_id and lt.leg_index = l.leg_index
          where l.order_id = c.id),
         c.fits
  from candidates c
  join public.vehicle_types vt on vt.id = c.vehicle_type_id
  cross join lateral (
    select sum(x.carrier_amount_cents) as carrier_amount_cents, sum(x.transport_carrier_cents) as transport_carrier_cents,
           sum(x.porters_carrier_cents) as porters_carrier_cents, sum(x.packing_carrier_cents) as packing_carrier_cents
    from public.order_leg_carrier_terms x where x.order_id = c.id
  ) t
  where cardinality(c.fits) > 0
  order by c.pickup_window_start, c.order_number;
end;
$$;
revoke execute on function public.list_available_jobs(uuid) from public, anon;
grant execute on function public.list_available_jobs(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- accept_job(order, vehicle): "Accetta la Corsa" (D120)
-- Atomic: the order row is locked (FOR UPDATE), so of two parallel calls exactly one assigns; the other waits and
-- then sees the order taken → 55000 'already_taken'. The same carrier calling again → no change, newly_assigned
-- false (double click). Checked again under the lock: eligibility (D21, D116), the vehicle (own, ready, fits),
-- pickup still in the future. The carrier row and the vehicle row are locked FOR SHARE, so a parallel suspension
-- or vehicle change waits for this transaction.
-- Errors: 42501 not eligible (detail = blocker codes) | 22023 order/vehicle not found or not own
--         55000 already_taken | not_available | too_late | vehicle_not_ready | vehicle_not_suitable (detail)
-- ---------------------------------------------------------------------------
create or replace function public.accept_job(p_order_id uuid, p_vehicle_id uuid)
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
    raise exception 'accept_job: not eligible' using errcode = '42501', detail = array_to_string(v_blockers, ',');
  end if;

  perform 1 from public.carrier_vehicles where id = p_vehicle_id and carrier_id = v_me for share;
  if not found then
    raise exception 'accept_job: vehicle not found' using errcode = '22023', detail = 'vehicle';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'accept_job: order not found' using errcode = '22023', detail = 'order';
  end if;

  if v_order.carrier_id = v_me and v_order.status = 'assigned' then
    return query select v_order.assigned_at, false;
    return;
  end if;
  if v_order.carrier_id is not null then
    raise exception 'accept_job: already taken' using errcode = '55000', detail = 'already_taken';
  end if;
  if v_order.status <> 'paid' then
    raise exception 'accept_job: not available' using errcode = '55000', detail = 'not_available';
  end if;
  if v_order.pickup_window_start <= v_now then
    raise exception 'accept_job: pickup window started' using errcode = '55000', detail = 'too_late';
  end if;
  if not public.carrier_vehicle_job_ready(p_vehicle_id) then
    raise exception 'accept_job: vehicle not ready' using errcode = '55000', detail = 'vehicle_not_ready';
  end if;
  if not public.vehicle_fits_order(p_vehicle_id, p_order_id) then
    raise exception 'accept_job: vehicle not suitable' using errcode = '55000', detail = 'vehicle_not_suitable';
  end if;

  update public.orders
     set status = 'assigned', carrier_id = v_me, carrier_vehicle_id = p_vehicle_id, assigned_at = v_now
   where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
  values (p_order_id, 'paid', 'assigned', v_me, 'carrier_app');

  return query select v_now, true;
end;
$$;
revoke execute on function public.accept_job(uuid, uuid) from public, anon;
grant execute on function public.accept_job(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- release_job(order): "Rinuncia alla corsa" (D121, extends D39)
-- Only the assigned carrier, only in status 'assigned' (not after pickup), and only
--   * within 15 minutes of accepting (mistaken click), or
--   * at least 48 hours before the start of the pickup window.
-- Otherwise "Segnala un problema" (D39, later step). Also allowed while suspended (the job is still the carrier's,
-- D116). The order goes back to 'paid' and to the list; history assigned → paid (carrier_app, who). The server
-- notifies the admin (e-mail) after a successful call.
-- Errors: 22023 order not found | 55000 not_assigned | too_late
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
  if v_order.carrier_id is distinct from v_me or v_order.status <> 'assigned' then
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
revoke execute on function public.release_job(uuid) from public, anon;
grant execute on function public.release_job(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- A vehicle on an assigned or ongoing job: no deactivation, no type or payload change (TODO from step 4).
-- For every role, no session flag. The plate is already immutable after the first approval (D107).
-- ---------------------------------------------------------------------------
create or replace function public.guard_vehicle_in_job()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if ((old.is_active and not new.is_active)
      or new.vehicle_type_id is distinct from old.vehicle_type_id
      or new.payload_kg is distinct from old.payload_kg)
     and exists (
       select 1 from public.orders o
       where o.carrier_vehicle_id = old.id and o.status in ('assigned', 'picked_up', 'in_transit')
     ) then
    raise exception 'Vehicle % is on an assigned or ongoing job', old.id using errcode = '55000', detail = 'vehicle_in_job';
  end if;
  return new;
end;
$$;

create trigger carrier_vehicles_c_guard_in_job
  before update on public.carrier_vehicles
  for each row execute function public.guard_vehicle_in_job();

-- Paid jobs without a carrier, by pickup time (the list's main filter).
create index orders_available_jobs_idx on public.orders (pickup_window_start) where status = 'paid' and carrier_id is null;
