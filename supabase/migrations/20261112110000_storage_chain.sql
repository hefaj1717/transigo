-- Storage chain (D153; decisions of the owner 2026-11-12 → D169–D172): "ritiro Transigo → deposito → consegna
-- Transigo" = separate linked orders, created in one transaction, one payment, one invoice.
--
--   * Group = the first order of the chain (root, parent_order_id null) + the orders pointing to it (flat, one level).
--     Root = the intake transport when Transigo collects the goods, otherwise the storage order.
--   * create_service_order(p) for storage accepts intake_transport / outbound_transport (create_order shape, one leg,
--     to / from the warehouse of the booking): intake on start_date, outbound on end_date. Monthly plan still refused
--     (step 10). create_order(p) is unchanged in behaviour — its body moves to create_transport_order() (internal,
--     no grants) so the chain transports pass exactly the same checks.
--   * Children copy the payment deadline of the root (D88) — the group is paid, expires and is reviewed together.
--   * Payment of the group: start_order_payment only on the root (amount = sum of the group), confirm_order_payment
--     pays / reviews every order of the group (idempotent: the payment row decides), expire_order expires the whole
--     group, expire_unpaid_orders walks roots only, admin_resolve_payment_review decides for the whole group.
--   * Money after payment: payments.order_id = root; refunds.order_id = the order refunded (any order of the group,
--     per-order cap = its total), queue_invoice sums the group, credit notes go to the shared invoice (unchanged).
--     order_main_payment(order) = the payment of its root.
--   * customer_cancel_order: a group is cancelled only as a whole and only while every order is 'paid' (no carrier)
--     and the storage has not started (D169); D33 fee per transport from its own pickup window, storage refunded in
--     full (D38); one refund row per order. A storage order (alone or in a group) is not cancellable by the customer
--     from 00:00 Europe/Rome of start_date (D170) → contact.
--   * customer_order_warehouse(order): name and address of the warehouse of the customer's own storage order (D171).
-- No new tables. New column grants: none. RLS: unchanged (carriers keep seeing only their assigned transport;
-- storage orders, warehouse_bookings and order_charges of the group stay invisible to them).

-- ---------------------------------------------------------------------------
-- Group helpers
-- ---------------------------------------------------------------------------
-- The first order of the chain (the order itself when it is not in a chain).
create function public.order_group_root(p_order_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(o.parent_order_id, o.id) from public.orders o where o.id = p_order_id;
$$;

-- A child: the root of the same customer, still unpaid; it takes the payment deadline of the root (D88).
create or replace function public.set_order_payment_due()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_window int;
  v_lead   int;
  v_parent public.orders%rowtype;
begin
  if new.parent_order_id is not null then
    select * into v_parent from public.orders where id = new.parent_order_id;
    if not found or v_parent.parent_order_id is not null or v_parent.customer_id <> new.customer_id
       or v_parent.status <> 'pending_payment' or new.status <> 'pending_payment' then
      raise exception 'orders: a chain order needs the unpaid first order of the same customer as parent (D153)' using errcode = '22023';
    end if;
    new.payment_due_at := v_parent.payment_due_at;
    return new;
  end if;
  select payment_window_minutes, min_booking_lead_hours into v_window, v_lead from public.settings where id;
  new.payment_due_at := greatest(
    now() + interval '30 minutes',
    least(now() + make_interval(mins => coalesce(v_window, 60)),
          new.pickup_window_start - make_interval(hours => coalesce(v_lead, 3)))
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_transport_order(p, parent, chain_role, warehouse) — the body of create_order() (20261108233000) plus the
-- chain transport (D153). Internal: no grants; called by create_order() and create_service_order().
-- Differences to the old body are marked "Chain".
-- ---------------------------------------------------------------------------
create function public.create_transport_order(p jsonb, p_parent_order_id uuid, p_chain_role text, p_warehouse_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_legs      jsonb := p -> 'legs';
  v_lines     jsonb := p -> 'lines';
  v_charges   jsonb := p -> 'charges';
  v_terms     jsonb := p -> 'carrier_terms';
  v_storage   jsonb := case when jsonb_typeof(p -> 'storage') = 'object' then p -> 'storage' end;
  v_leg_count int;
  v_order     public.orders%rowtype;
  v_bad       int;
begin
  if jsonb_typeof(v_legs) is distinct from 'array' or jsonb_typeof(v_lines) is distinct from 'array'
     or jsonb_typeof(v_charges) is distinct from 'object' or jsonb_typeof(v_terms) is distinct from 'array' then
    raise exception 'create_order: legs, lines, charges and carrier_terms are required' using errcode = '22023';
  end if;

  v_leg_count := jsonb_array_length(v_legs);
  if v_leg_count not between 1 and 2 then
    raise exception 'create_order: an order has 1 or 2 legs' using errcode = '22023';
  end if;
  -- Chain transports (D153): one leg, no storage payload, to / from the warehouse of the booking.
  if p_chain_role is not null then
    if p_chain_role not in ('intake', 'outbound') or p_warehouse_id is null or v_storage is not null or v_leg_count <> 1 then
      raise exception 'create_order: a chain transport has one leg, a warehouse and no storage' using errcode = '22023';
    end if;
  elsif p_parent_order_id is not null or p_warehouse_id is not null then
    raise exception 'create_order: parent and warehouse only for chain transports' using errcode = '22023';
  end if;
  if (v_storage is not null) <> (v_leg_count = 2) then
    raise exception 'create_order: a storage order has exactly 2 legs, other orders 1 (D47)' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles pr
    where pr.id = (p ->> 'customer_id')::uuid and pr.role = 'cliente' and not pr.is_blocked
  ) then
    raise exception 'create_order: customer not found or blocked' using errcode = '22023';
  end if;

  insert into public.orders (
    customer_id, parent_order_id, vehicle_type_id, pickup_window_start,
    goods_description, items_count, weight_kg, goods_dimensions_note,
    largest_item_length_cm, largest_item_width_cm, largest_item_height_cm, pallets_count, load_category,
    packing_items_count,
    storage_type, storage_billing_unit, storage_days, storage_pallets, warehouse_id,
    pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone, customer_notes
  ) values (
    (p ->> 'customer_id')::uuid,
    p_parent_order_id,
    (p ->> 'vehicle_type_id')::uuid,
    (select (e ->> 'pickup_window_start')::timestamptz from jsonb_array_elements(v_legs) e where (e ->> 'leg_index')::int = 0),
    p ->> 'goods_description',
    (p ->> 'items_count')::int,
    (p ->> 'weight_kg')::int,
    p ->> 'goods_dimensions_note',
    (p ->> 'largest_item_length_cm')::int,
    (p ->> 'largest_item_width_cm')::int,
    (p ->> 'largest_item_height_cm')::int,
    (p ->> 'pallets_count')::int,
    (p ->> 'load_category')::public.porter_package_code,
    coalesce((p ->> 'packing_items_count')::int, 0),
    (v_storage ->> 'storage_type')::public.storage_type,
    (v_storage ->> 'storage_billing_unit')::public.storage_billing_unit,
    (v_storage ->> 'storage_days')::int,
    (v_storage ->> 'storage_pallets')::int,
    (v_storage ->> 'warehouse_id')::uuid,
    p ->> 'pickup_contact_name',
    p ->> 'pickup_contact_phone',
    p ->> 'delivery_contact_name',
    p ->> 'delivery_contact_phone',
    p ->> 'customer_notes'
  )
  returning * into v_order;

  insert into public.order_legs (
    order_id, leg_index,
    pickup_address, pickup_place_id, pickup_lat, pickup_lng, pickup_city, pickup_postal_code, pickup_province, pickup_warehouse_id,
    delivery_address, delivery_place_id, delivery_lat, delivery_lng, delivery_city, delivery_postal_code, delivery_province, delivery_warehouse_id,
    distance_m, duration_s, pickup_date, pickup_window_start, pickup_window_end,
    pickup_floor, pickup_has_elevator, delivery_floor, delivery_has_elevator, is_urgent,
    porter_package_code, porters_count, porters_included_hours, porter_overtime_grace_minutes
  )
  select
    v_order.id, l.leg_index,
    l.pickup_address, l.pickup_place_id, l.pickup_lat, l.pickup_lng, l.pickup_city, l.pickup_postal_code, l.pickup_province, l.pickup_warehouse_id,
    l.delivery_address, l.delivery_place_id, l.delivery_lat, l.delivery_lng, l.delivery_city, l.delivery_postal_code, l.delivery_province, l.delivery_warehouse_id,
    l.distance_m, l.duration_s, l.pickup_date, l.pickup_window_start, l.pickup_window_end,
    coalesce(l.pickup_floor, 0), coalesce(l.pickup_has_elevator, false), coalesce(l.delivery_floor, 0), coalesce(l.delivery_has_elevator, false), l.is_urgent,
    l.porter_package_code, coalesce(l.porters_count, 0), l.porters_included_hours, l.porter_overtime_grace_minutes
  from jsonb_to_recordset(v_legs) as l(
    leg_index smallint,
    pickup_address text, pickup_place_id text, pickup_lat double precision, pickup_lng double precision,
    pickup_city text, pickup_postal_code text, pickup_province char(2), pickup_warehouse_id uuid,
    delivery_address text, delivery_place_id text, delivery_lat double precision, delivery_lng double precision,
    delivery_city text, delivery_postal_code text, delivery_province char(2), delivery_warehouse_id uuid,
    distance_m integer, duration_s integer, pickup_date date, pickup_window_start timestamptz, pickup_window_end timestamptz,
    pickup_floor smallint, pickup_has_elevator boolean, delivery_floor smallint, delivery_has_elevator boolean, is_urgent boolean,
    porter_package_code public.porter_package_code, porters_count smallint, porters_included_hours smallint,
    porter_overtime_grace_minutes smallint
  );

  -- Legs are 0..n-1 (the primary key and the 0–1 check do the rest).
  if not exists (select 1 from public.order_legs where order_id = v_order.id and leg_index = 0) then
    raise exception 'create_order: legs must be numbered from 0' using errcode = '22023';
  end if;

  -- Warehouse legs (D47, D72): A→warehouse, then warehouse→B, not earlier than leg 1; no warehouse otherwise.
  -- Chain transports (D153): intake = A→warehouse, outbound = warehouse→B, the warehouse of the booking.
  if p_chain_role is not null then
    if not exists (
      select 1 from public.order_legs l
      where l.order_id = v_order.id and l.leg_index = 0
        and case p_chain_role
              when 'intake'   then l.pickup_warehouse_id is null and l.delivery_warehouse_id = p_warehouse_id
              else                 l.pickup_warehouse_id = p_warehouse_id and l.delivery_warehouse_id is null
            end
    ) then
      raise exception 'create_order: chain leg must go to / from the warehouse of the booking' using errcode = '22023';
    end if;
  elsif v_storage is not null then
    if not exists (
      select 1
      from public.order_legs l0
      join public.order_legs l1 on l1.order_id = l0.order_id and l1.leg_index = 1
      where l0.order_id = v_order.id and l0.leg_index = 0
        and l0.pickup_warehouse_id is null and l0.delivery_warehouse_id = v_order.warehouse_id
        and l1.pickup_warehouse_id = v_order.warehouse_id and l1.delivery_warehouse_id is null
        and l1.pickup_window_start >= l0.pickup_window_start
    ) then
      raise exception 'create_order: storage legs must be A→warehouse and warehouse→B, in order' using errcode = '22023';
    end if;
  elsif exists (
    select 1 from public.order_legs
    where order_id = v_order.id and (pickup_warehouse_id is not null or delivery_warehouse_id is not null)
  ) then
    raise exception 'create_order: warehouse leg without storage' using errcode = '22023';
  end if;

  insert into public.order_charges (
    order_id, price_list_id, price_list_version, customer_type, vat_rate_bp,
    subtotal_cents, vat_cents, total_cents, porter_overtime_rate_cents,
    billing_details, terms_accepted_at, terms_version, quoted_at
  ) values (
    v_order.id,
    (v_charges ->> 'price_list_id')::uuid,
    (v_charges ->> 'price_list_version')::int,
    (v_charges ->> 'customer_type')::public.customer_type,
    (v_charges ->> 'vat_rate_bp')::int,
    (v_charges ->> 'subtotal_cents')::int,
    (v_charges ->> 'vat_cents')::int,
    (v_charges ->> 'total_cents')::int,
    (v_charges ->> 'porter_overtime_rate_cents')::int,
    v_charges -> 'billing_details',
    (v_charges ->> 'terms_accepted_at')::timestamptz,
    v_charges ->> 'terms_version',
    (v_charges ->> 'quoted_at')::timestamptz
  );

  insert into public.order_lines (
    order_id, sort_order, leg_index, line_type, label_it, quantity, unit_amount_cents,
    net_cents, vat_cents, gross_cents, carrier_share_group
  )
  select v_order.id, li.sort_order, li.leg_index, li.line_type, li.label_it, li.quantity, li.unit_amount_cents,
         li.net_cents, li.vat_cents, li.gross_cents, li.carrier_share_group
  from jsonb_to_recordset(v_lines) as li(
    sort_order smallint, leg_index smallint, line_type public.order_line_type, label_it text, quantity integer,
    unit_amount_cents integer, net_cents integer, vat_cents integer, gross_cents integer,
    carrier_share_group public.carrier_share_group
  );

  insert into public.order_leg_carrier_terms (
    order_id, leg_index, carrier_amount_cents, transport_carrier_cents, porters_carrier_cents, packing_carrier_cents,
    porter_share_kind, porter_share_bp, porter_share_carrier_cents, porter_share_net_cents
  )
  select v_order.id, t.leg_index, t.carrier_amount_cents,
         coalesce(t.transport_carrier_cents, 0), coalesce(t.porters_carrier_cents, 0), coalesce(t.packing_carrier_cents, 0),
         t.porter_share_kind, t.porter_share_bp, t.porter_share_carrier_cents, t.porter_share_net_cents
  from jsonb_to_recordset(v_terms) as t(
    leg_index smallint, carrier_amount_cents integer, transport_carrier_cents integer, porters_carrier_cents integer,
    packing_carrier_cents integer, porter_share_kind text, porter_share_bp integer, porter_share_carrier_cents integer,
    porter_share_net_cents integer
  );

  -- Consistency of the snapshot ------------------------------------------------
  if (select count(*) from public.order_lines where order_id = v_order.id) = 0 then
    raise exception 'create_order: an order needs price lines' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.order_charges c,
         lateral (select coalesce(sum(net_cents), 0) as net, coalesce(sum(vat_cents), 0) as vat
                  from public.order_lines where order_id = v_order.id) s
    where c.order_id = v_order.id and (c.subtotal_cents <> s.net or c.vat_cents <> s.vat)
  ) then
    raise exception 'create_order: line totals do not match the charges' using errcode = '22023';
  end if;

  select count(*) into v_bad
  from public.order_lines
  where order_id = v_order.id and leg_index >= v_leg_count;
  if v_bad > 0 then
    raise exception 'create_order: price line for a missing leg' using errcode = '22023';
  end if;

  -- porters on a leg ⇔ a porters line for that leg (D74)
  select count(*) into v_bad
  from public.order_legs l
  where l.order_id = v_order.id
    and (l.porter_package_code is not null) <> exists (
      select 1 from public.order_lines li
      where li.order_id = l.order_id and li.leg_index = l.leg_index and li.line_type = 'porters'
    );
  if v_bad > 0 then
    raise exception 'create_order: porters of a leg do not match its price lines' using errcode = '22023';
  end if;

  if (v_order.packing_items_count > 0) <> exists (
    select 1 from public.order_lines where order_id = v_order.id and line_type = 'packing'
  ) then
    raise exception 'create_order: packing does not match the price lines' using errcode = '22023';
  end if;

  if (v_storage is not null) <> exists (
    select 1 from public.order_lines where order_id = v_order.id and line_type = 'storage'
  ) then
    raise exception 'create_order: storage does not match the price lines' using errcode = '22023';
  end if;

  -- one carrier row per leg; an overtime share only on a leg with porters
  if (select count(*) from public.order_leg_carrier_terms where order_id = v_order.id) <> v_leg_count then
    raise exception 'create_order: carrier terms are required for every leg' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.order_leg_carrier_terms t
    join public.order_legs l on l.order_id = t.order_id and l.leg_index = t.leg_index
    where t.order_id = v_order.id and t.porter_share_kind is not null and l.porter_package_code is null
  ) then
    raise exception 'create_order: porter share on a leg without porters' using errcode = '22023';
  end if;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
  values (v_order.id, null, v_order.status, v_order.customer_id, 'customer_app');

  return jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number);
end;
$$;

revoke execute on function public.create_transport_order(jsonb, uuid, text, uuid) from public, anon, authenticated, service_role;

-- create_order(p): unchanged contract (single transport order, also the old two-leg storage orders).
create or replace function public.create_order(p jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.create_transport_order(p, null, null, null);
$$;

-- ---------------------------------------------------------------------------
-- create_service_order(p) — as 20261111200001 plus the chain for storage (D153):
--   intake_transport  { create_order payload, one leg, delivery_warehouse_id = booking.warehouse_id,
--                       legs[0].pickup_date = start_date }        ⇔ booking.intake = 'transigo'
--   outbound_transport{ …, pickup_warehouse_id = booking.warehouse_id, legs[0].pickup_date = end_date }
--                                                                   ⇔ booking.outbound = 'transigo'
-- Returns { id, order_number } of the root (the order to pay) and, for storage, orders: [{ id, order_number, role }]
-- with role intake | storage | outbound, in chain order.
-- ---------------------------------------------------------------------------
create or replace function public.create_service_order(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type    public.service_type := (p ->> 'service_type')::public.service_type;
  v_job     jsonb := case when jsonb_typeof(p -> 'porter_job') = 'object' then p -> 'porter_job' end;
  v_booking jsonb := case when jsonb_typeof(p -> 'booking') = 'object' then p -> 'booking' end;
  v_terms   jsonb := case when jsonb_typeof(p -> 'porter_terms') = 'object' then p -> 'porter_terms' end;
  v_charges jsonb := p -> 'charges';
  v_lines   jsonb := p -> 'lines';
  v_list    public.price_lists%rowtype;
  v_order   public.orders%rowtype;
  v_start   timestamptz;
  v_today   date := (now() at time zone 'Europe/Rome')::date;
  v_bad     int;
  v_needed  int;
  v_intake   jsonb := case when jsonb_typeof(p -> 'intake_transport') = 'object' then p -> 'intake_transport' end;
  v_outbound jsonb := case when jsonb_typeof(p -> 'outbound_transport') = 'object' then p -> 'outbound_transport' end;
  v_wh       uuid := (v_booking ->> 'warehouse_id')::uuid;
  v_root     uuid;            -- first order of the chain (D153): the intake transport, otherwise the storage order
  v_created  jsonb;
  v_group    jsonb := '[]'::jsonb;
begin
  if v_type is null or v_type = 'transport' then
    raise exception 'create_service_order: service_type must be porters or storage (transport: create_order)' using errcode = '22023';
  end if;
  if jsonb_typeof(v_charges) is distinct from 'object' or jsonb_typeof(v_lines) is distinct from 'array' then
    raise exception 'create_service_order: charges and lines are required' using errcode = '22023';
  end if;
  if (v_type = 'porters') <> (v_job is not null and v_terms is not null) or (v_type = 'storage') <> (v_booking is not null) then
    raise exception 'create_service_order: porters need porter_job and porter_terms, storage needs booking' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles pr
    where pr.id = (p ->> 'customer_id')::uuid and pr.role = 'cliente' and not pr.is_blocked
  ) then
    raise exception 'create_service_order: customer not found or blocked' using errcode = '22023';
  end if;

  select * into v_list from public.price_lists where id = (v_charges ->> 'price_list_id')::uuid;
  if not found then
    raise exception 'create_service_order: unknown price list' using errcode = '22023';
  end if;

  -- Service-specific checks -----------------------------------------------------
  if v_type = 'porters' then
    v_start := (v_job ->> 'window_start')::timestamptz;
    if v_start <= now() then
      raise exception 'create_service_order: the job must start in the future' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.service_area_provinces
      where province_code = upper(v_job ->> 'province') and is_active
    ) then
      raise exception 'create_service_order: province outside the service area (D13)' using errcode = '22023';
    end if;
    if (v_job ->> 'persons')::int < v_list.porters_min_persons
       or (v_job ->> 'billed_hours')::int < greatest((v_job ->> 'requested_hours')::int, v_list.porters_min_hours) then
      raise exception 'create_service_order: persons or hours below the price list minimum (D157)' using errcode = '22023';
    end if;
  else
    if (v_booking ->> 'start_date')::date < v_today then
      raise exception 'create_service_order: storage cannot start in the past' using errcode = '22023';
    end if;
    -- Monthly plan: step 10 (D155).
    if coalesce(v_booking ->> 'payment_plan', 'upfront') <> 'upfront' then
      raise exception 'create_service_order: monthly payment is not available yet' using errcode = '22023';
    end if;
    -- Chain (D153): intake / outbound by Transigo ⇔ a transport payload for it (create_order shape, one leg).
    if (v_booking ->> 'intake' = 'transigo') <> (v_intake is not null)
       or (v_booking ->> 'outbound' = 'transigo') <> (v_outbound is not null) then
      raise exception 'create_service_order: intake/outbound by Transigo need their transport (and only then)' using errcode = '22023';
    end if;
    if p ? 'intake_transport' and v_intake is null or p ? 'outbound_transport' and v_outbound is null then
      raise exception 'create_service_order: intake_transport / outbound_transport must be objects' using errcode = '22023';
    end if;
    if (v_intake is not null and (v_intake ->> 'customer_id') is distinct from (p ->> 'customer_id'))
       or (v_outbound is not null and (v_outbound ->> 'customer_id') is distinct from (p ->> 'customer_id')) then
      raise exception 'create_service_order: the chain belongs to one customer' using errcode = '22023';
    end if;
    -- The intake arrives on the first day, the outbound leaves on the last day (wizard: okno = end_date).
    if v_intake is not null and (v_intake #>> '{legs,0,pickup_date}')::date is distinct from (v_booking ->> 'start_date')::date
       or v_outbound is not null and (v_outbound #>> '{legs,0,pickup_date}')::date is distinct from (v_booking ->> 'end_date')::date then
      raise exception 'create_service_order: intake on start_date, outbound on end_date' using errcode = '22023';
    end if;
    -- D154: boxes for private customers, pallets for businesses
    if (v_booking ->> 'unit' = 'box') <> (v_charges ->> 'customer_type' = 'private') then
      raise exception 'create_service_order: boxes are for private customers, pallets for businesses (D154)' using errcode = '22023';
    end if;
    if v_booking ->> 'unit' = 'box' and not exists (
      select 1 from public.price_list_storage_boxes
      where price_list_id = v_list.id and code = v_booking ->> 'box_code' and is_enabled
    ) then
      raise exception 'create_service_order: box not offered by the price list' using errcode = '22023';
    end if;
    -- Midnight in Rome of the first day: from then on the storage has started (customer cancellation, D170).
    v_start := ((v_booking ->> 'start_date')::date)::timestamp at time zone 'Europe/Rome';

    -- Capacity (D156): one booking at a time per warehouse — the row lock serialises the race for the last unit.
    perform 1 from public.warehouses w
    where w.id = v_wh and w.is_active
    for update;
    if not found then
      raise exception 'create_service_order: warehouse not found or not active' using errcode = '22023';
    end if;
    v_needed := case when v_booking ->> 'unit' = 'box' then 1 else (v_booking ->> 'pallets')::int end;
    if public.warehouse_free_units(
         (v_booking ->> 'warehouse_id')::uuid, (v_booking ->> 'unit')::public.storage_unit, v_booking ->> 'box_code',
         (v_booking ->> 'start_date')::date, (v_booking ->> 'end_date')::date
       ) < v_needed then
      raise exception 'create_service_order: no free space for the period' using errcode = '23P01';
    end if;
  end if;

  -- Chain head: the intake transport is the first order of the chain (D153) ---------------
  if v_intake is not null then
    v_created := public.create_transport_order(v_intake, null, 'intake', v_wh);
    v_root := (v_created ->> 'id')::uuid;
    v_group := v_group || jsonb_build_object('id', v_root, 'order_number', v_created ->> 'order_number', 'role', 'intake');
  end if;

  -- Order ---------------------------------------------------------------------------
  insert into public.orders (
    customer_id, parent_order_id, service_type, pickup_window_start, goods_description, customer_notes,
    pickup_contact_name, pickup_contact_phone
  ) values (
    (p ->> 'customer_id')::uuid,
    v_root,
    v_type,
    v_start,
    p ->> 'goods_description',
    p ->> 'customer_notes',
    case when v_type = 'porters' then p ->> 'site_contact_name' end,
    case when v_type = 'porters' then p ->> 'site_contact_phone' end
  )
  returning * into v_order;

  if v_type = 'porters' then
    insert into public.order_porter_jobs (
      order_id, address, place_id, lat, lng, city, postal_code, province, job_date, window_start, window_end,
      floor, has_elevator, persons, requested_hours, billed_hours, is_urgent, overtime_grace_minutes
    ) values (
      v_order.id, v_job ->> 'address', v_job ->> 'place_id', (v_job ->> 'lat')::float8, (v_job ->> 'lng')::float8,
      v_job ->> 'city', v_job ->> 'postal_code', upper(v_job ->> 'province'), (v_job ->> 'job_date')::date,
      (v_job ->> 'window_start')::timestamptz, (v_job ->> 'window_end')::timestamptz,
      coalesce((v_job ->> 'floor')::smallint, 0), coalesce((v_job ->> 'has_elevator')::boolean, false),
      (v_job ->> 'persons')::smallint, (v_job ->> 'requested_hours')::smallint, (v_job ->> 'billed_hours')::smallint,
      (v_job ->> 'is_urgent')::boolean, (v_job ->> 'overtime_grace_minutes')::smallint
    );
    insert into public.order_porter_carrier_terms (
      order_id, carrier_amount_cents, porter_share_kind, porter_share_bp, porter_share_carrier_cents, porter_share_net_cents
    ) values (
      v_order.id, (v_terms ->> 'carrier_amount_cents')::int, v_terms ->> 'porter_share_kind',
      (v_terms ->> 'porter_share_bp')::int, (v_terms ->> 'porter_share_carrier_cents')::int, (v_terms ->> 'porter_share_net_cents')::int
    );
  else
    insert into public.warehouse_bookings (
      order_id, warehouse_id, unit, box_code, pallets, start_date, end_date, payment_plan, intake, outbound
    ) values (
      v_order.id, (v_booking ->> 'warehouse_id')::uuid, (v_booking ->> 'unit')::public.storage_unit,
      v_booking ->> 'box_code', (v_booking ->> 'pallets')::int,
      (v_booking ->> 'start_date')::date, (v_booking ->> 'end_date')::date,
      coalesce(v_booking ->> 'payment_plan', 'upfront')::public.storage_payment_plan,
      (v_booking ->> 'intake')::public.storage_intake, (v_booking ->> 'outbound')::public.storage_outbound
    );
  end if;

  insert into public.order_charges (
    order_id, price_list_id, price_list_version, customer_type, vat_rate_bp,
    subtotal_cents, vat_cents, total_cents, porter_overtime_rate_cents,
    billing_details, terms_accepted_at, terms_version, quoted_at
  ) values (
    v_order.id, v_list.id, (v_charges ->> 'price_list_version')::int,
    (v_charges ->> 'customer_type')::public.customer_type, (v_charges ->> 'vat_rate_bp')::int,
    (v_charges ->> 'subtotal_cents')::int, (v_charges ->> 'vat_cents')::int, (v_charges ->> 'total_cents')::int,
    case when v_type = 'porters' then (v_charges ->> 'porter_overtime_rate_cents')::int end,
    v_charges -> 'billing_details', (v_charges ->> 'terms_accepted_at')::timestamptz,
    v_charges ->> 'terms_version', (v_charges ->> 'quoted_at')::timestamptz
  );

  insert into public.order_lines (
    order_id, sort_order, leg_index, line_type, label_it, quantity, unit_amount_cents,
    net_cents, vat_cents, gross_cents, carrier_share_group
  )
  select v_order.id, li.sort_order, li.leg_index, li.line_type, li.label_it, li.quantity, li.unit_amount_cents,
         li.net_cents, li.vat_cents, li.gross_cents, li.carrier_share_group
  from jsonb_to_recordset(v_lines) as li(
    sort_order smallint, leg_index smallint, line_type public.order_line_type, label_it text, quantity integer,
    unit_amount_cents integer, net_cents integer, vat_cents integer, gross_cents integer,
    carrier_share_group public.carrier_share_group
  );

  -- Consistency of the snapshot ----------------------------------------------------
  if exists (
    select 1
    from public.order_charges c,
         lateral (select count(*) as n, coalesce(sum(net_cents), 0) as net, coalesce(sum(vat_cents), 0) as vat
                  from public.order_lines where order_id = v_order.id) s
    where c.order_id = v_order.id and (s.n = 0 or c.subtotal_cents <> s.net or c.vat_cents <> s.vat)
  ) then
    raise exception 'create_service_order: line totals do not match the charges' using errcode = '22023';
  end if;

  if v_type = 'porters' then
    -- Porter lines refer to the job as leg 0, in the porters carrier group (D159); exactly one porters line;
    -- a floors line only for a floor without elevator.
    select count(*) into v_bad from public.order_lines
    where order_id = v_order.id
      and (leg_index is distinct from 0 or carrier_share_group <> 'porters'
           or line_type not in ('porters', 'porters_floors', 'surcharge_urgent', 'surcharge_weekend_holiday'));
    if v_bad > 0
       or (select count(*) from public.order_lines where order_id = v_order.id and line_type = 'porters') <> 1
       or exists (
         select 1 from public.order_lines li join public.order_porter_jobs j on j.order_id = li.order_id
         where li.order_id = v_order.id and li.line_type = 'porters_floors' and (j.floor = 0 or j.has_elevator)
       ) then
      raise exception 'create_service_order: porter lines do not match the job' using errcode = '22023';
    end if;
  else
    -- Storage is 100 % Transigo (D57): storage lines only, no leg, no carrier group.
    if exists (
      select 1 from public.order_lines
      where order_id = v_order.id and (line_type <> 'storage' or carrier_share_group <> 'none')
    ) then
      raise exception 'create_service_order: storage orders have storage lines only' using errcode = '22023';
    end if;
  end if;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
  values (v_order.id, null, v_order.status, v_order.customer_id, 'customer_app');

  if v_type = 'porters' then
    return jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number);
  end if;

  v_group := v_group || jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number, 'role', 'storage');
  v_root := coalesce(v_root, v_order.id);
  if v_outbound is not null then
    v_created := public.create_transport_order(v_outbound, v_root, 'outbound', v_wh);
    v_group := v_group || jsonb_build_object('id', v_created ->> 'id', 'order_number', v_created ->> 'order_number', 'role', 'outbound');
  end if;

  -- One payment and one invoice for the group (D153): the same customer type, VAT rate, price list, billing
  -- details and terms on every order of the chain.
  if (select count(distinct (c.customer_type, c.vat_rate_bp, c.price_list_id, c.billing_details, c.terms_version))
        from public.order_charges c join public.orders o on o.id = c.order_id
       where o.id = v_root or o.parent_order_id = v_root) <> 1 then
    raise exception 'create_service_order: the orders of a chain must share price list, VAT and billing details' using errcode = '22023';
  end if;

  return jsonb_build_object('id', v_root, 'order_number', (select order_number from public.orders where id = v_root),
                            'orders', v_group);
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment of a group (D153). Lock order everywhere: payment → root → children (by id).
-- ---------------------------------------------------------------------------
create or replace function public.start_order_payment(
  p_order_id uuid, p_session_id text, p_amount_cents integer, p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_total bigint;
  v_id    uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'start_order_payment: order not found' using errcode = 'P0002';
  end if;
  if v_order.parent_order_id is not null then
    raise exception 'start_order_payment: a chain is paid on its first order' using errcode = '22023', detail = 'not_group_root';
  end if;
  perform 1 from public.orders where parent_order_id = p_order_id order by id for update;
  if v_order.status <> 'pending_payment'
     or exists (select 1 from public.orders where parent_order_id = p_order_id and status <> 'pending_payment') then
    raise exception 'start_order_payment: order is not awaiting payment (status %)', v_order.status using errcode = '22023';
  end if;
  if now() >= v_order.payment_due_at then
    raise exception 'start_order_payment: payment deadline passed' using errcode = '22023';
  end if;
  select sum(c.total_cents) into v_total
    from public.order_charges c join public.orders o on o.id = c.order_id
   where o.id = p_order_id or o.parent_order_id = p_order_id;
  if p_amount_cents is distinct from v_total then
    raise exception 'start_order_payment: amount % differs from the order total %', p_amount_cents, v_total using errcode = '22023';
  end if;

  insert into public.payments (order_id, amount_cents, stripe_checkout_session_id, transfer_group, expires_at)
  values (p_order_id, p_amount_cents, p_session_id, v_order.order_number, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;

-- Idempotent: the payment row decides (a second event → already_processed, nothing changes). The result keeps the
-- root's id / number / status; group_order_ids lists every order of the group (for e-mails).
create or replace function public.confirm_order_payment(
  p_session_id text, p_payment_intent_id text, p_charge_id text, p_amount_cents integer, p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay    public.payments%rowtype;
  v_order  public.orders%rowtype;
  v_total  bigint;
  v_reason text;
  v_ids    jsonb;
begin
  select * into v_pay from public.payments where stripe_checkout_session_id = p_session_id for update;
  if not found then
    raise exception 'confirm_order_payment: unknown Checkout session' using errcode = 'P0002';
  end if;
  select * into v_order from public.orders where id = v_pay.order_id for update;
  perform 1 from public.orders where parent_order_id = v_order.id order by id for update;
  select jsonb_agg(o.id order by o.created_at, o.id) into v_ids
    from public.orders o where o.id = v_order.id or o.parent_order_id = v_order.id;

  if v_pay.status = 'succeeded' then
    return jsonb_build_object('result', 'already_processed', 'order_id', v_order.id, 'order_number', v_order.order_number,
                              'status', v_order.status, 'group_order_ids', v_ids);
  end if;

  select sum(c.total_cents) into v_total
    from public.order_charges c join public.orders o on o.id = c.order_id
   where o.id = v_order.id or o.parent_order_id = v_order.id;

  if lower(coalesce(p_currency, '')) <> 'eur' then
    v_reason := 'currency_mismatch';
  elsif p_amount_cents is distinct from v_pay.amount_cents or p_amount_cents is distinct from v_total then
    v_reason := 'amount_mismatch';
  elsif v_order.status = 'expired' then
    v_reason := 'late_payment';
  elsif v_order.status <> 'pending_payment' then
    v_reason := 'duplicate_payment';
  end if;

  update public.payments
     set status = 'succeeded', stripe_payment_intent_id = p_payment_intent_id, stripe_charge_id = p_charge_id,
         amount_received_cents = p_amount_cents, received_currency = lower(p_currency), paid_at = now(),
         review_reason = v_reason
   where id = v_pay.id;

  if v_reason is null then
    with upd as (
      update public.orders set status = 'paid', paid_at = now()
       where (id = v_order.id or parent_order_id = v_order.id) and status = 'pending_payment'
      returning id
    )
    insert into public.order_status_history (order_id, from_status, to_status, source)
    select id, 'pending_payment', 'paid', 'stripe_webhook' from upd;
    return jsonb_build_object('result', 'paid', 'order_id', v_order.id, 'order_number', v_order.order_number,
                              'status', 'paid', 'group_order_ids', v_ids);
  end if;

  if v_order.status in ('pending_payment', 'expired') then
    with upd as (
      update public.orders set status = 'payment_review'
       where (id = v_order.id or parent_order_id = v_order.id) and status = v_order.status   -- the group moves together
      returning id
    )
    insert into public.order_status_history (order_id, from_status, to_status, source, note)
    select id, v_order.status, 'payment_review', 'stripe_webhook', 'Pagamento da verificare' from upd;
    v_order.status := 'payment_review';
  end if;
  return jsonb_build_object('result', 'review', 'reason', v_reason, 'order_id', v_order.id, 'order_number', v_order.order_number,
                            'status', v_order.status, 'group_order_ids', v_ids);
end;
$$;

-- Any order of a group expires the whole group (the root decides: its status, its open payment, its deadline).
create or replace function public.expire_order(
  p_order_id uuid, p_source public.status_source, p_changed_by uuid default null, p_note text default null, p_force boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_root  uuid := public.order_group_root(p_order_id);
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = v_root for update;
  if not found or v_order.status <> 'pending_payment' then
    return false;
  end if;
  perform 1 from public.orders where parent_order_id = v_root order by id for update;
  if exists (select 1 from public.payments where order_id = v_root and status = 'pending') then
    return false;
  end if;
  if not p_force and now() < v_order.payment_due_at - interval '2 minutes' then
    return false;
  end if;
  with upd as (
    update public.orders set status = 'expired'
     where (id = v_root or parent_order_id = v_root) and status = 'pending_payment'
    returning id
  )
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, note)
  select id, 'pending_payment', 'expired', p_changed_by, p_source, p_note from upd;
  return true;
end;
$$;

create or replace function public.expire_unpaid_orders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n  integer := 0;
begin
  for v_id in
    select o.id from public.orders o
     where o.status = 'pending_payment' and o.parent_order_id is null      -- roots only: children expire with them
       and o.payment_due_at <= now() - interval '2 minutes'
       and not exists (select 1 from public.payments p where p.order_id = o.id and p.status = 'pending')
  loop
    if public.expire_order(v_id, 'system_job') then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Money after payment
-- ---------------------------------------------------------------------------
-- The payment an order stands on = the accepted payment of its root.
create or replace function public.order_main_payment(p_order_id uuid)
returns public.payments
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from public.payments p
   where p.order_id = public.order_group_root(p_order_id) and p.status = 'succeeded'
     and (p.review_reason is null or p.review_outcome = 'accepted')
   order by p.paid_at
   limit 1;
$$;

-- A refund belongs to a succeeded payment of its group. Per payment: ≤ received (as before). Per order of a chain:
-- ≤ its own total — otherwise order_charges.refunded_cents (≤ total) would fail AFTER Stripe has refunded.
create or replace function public.check_refund_total()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay   public.payments%rowtype;
  v_sum   bigint;
  v_total integer;
begin
  select * into v_pay from public.payments where id = new.payment_id for update;
  if v_pay.order_id is distinct from public.order_group_root(new.order_id) or v_pay.status <> 'succeeded' then
    raise exception 'Refund must belong to a succeeded payment of the same order or chain' using errcode = '23514';
  end if;
  select coalesce(sum(amount_cents), 0) into v_sum
    from public.refunds where payment_id = new.payment_id and status <> 'failed' and id <> new.id;
  if new.status <> 'failed' and v_sum + new.amount_cents > coalesce(v_pay.amount_received_cents, v_pay.amount_cents) then
    raise exception 'Refunds exceed the payment amount' using errcode = '23514';
  end if;
  if new.status <> 'failed' and (
       new.order_id <> v_pay.order_id or exists (select 1 from public.orders where parent_order_id = new.order_id)) then
    select total_cents into v_total from public.order_charges where order_id = new.order_id;
    select coalesce(sum(amount_cents), 0) into v_sum
      from public.refunds where order_id = new.order_id and status <> 'failed' and id <> new.id;
    if v_sum + new.amount_cents > v_total then
      raise exception 'Refunds exceed the amount of this order of the chain' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- Still refundable on one order: the payment remainder, and for an order of a chain at most its own remainder.
create function public.order_refundable_cents(p_order_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when o.parent_order_id is null and not exists (select 1 from public.orders c where c.parent_order_id = o.id)
      then public.payment_refundable_cents(m.id)
    else least(public.payment_refundable_cents(m.id),
               greatest(ch.total_cents - coalesce((select sum(r.amount_cents) from public.refunds r
                                                    where r.order_id = o.id and r.status <> 'failed'), 0), 0))::integer
  end
  from public.orders o
  join public.order_charges ch on ch.order_id = o.id
  cross join lateral public.order_main_payment(o.id) m
  where o.id = p_order_id and m.id is not null;
$$;

-- One invoice for the group (D153): amounts = sum of the group (payments.order_id is the root).
create or replace function public.queue_invoice(p_payment_id uuid, p_provider text)
returns table (invoice_id uuid, newly_queued boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_pay   public.payments%rowtype;
  v_main  uuid;
  v_net   bigint;
  v_vat   bigint;
  v_total bigint;
  v_id    uuid;
begin
  if p_provider is null or p_provider not in ('demo', 'fatture_in_cloud') then
    raise exception 'queue_invoice: unknown provider' using errcode = '22023', detail = 'provider';
  end if;
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'queue_invoice: payment not found' using errcode = '22023', detail = 'payment';
  end if;
  select i.id into v_id from public.invoices i where i.payment_id = p_payment_id and i.kind = 'invoice';
  if found then
    return query select v_id, false;
    return;
  end if;
  select (public.order_main_payment(v_pay.order_id)).id into v_main;
  if v_main is distinct from v_pay.id then
    raise exception 'queue_invoice: payment is not the accepted payment of its order' using errcode = '55000', detail = 'payment_not_accepted';
  end if;
  select sum(c.subtotal_cents), sum(c.vat_cents), sum(c.total_cents) into v_net, v_vat, v_total
    from public.order_charges c join public.orders o on o.id = c.order_id
   where o.id = v_pay.order_id or o.parent_order_id = v_pay.order_id;
  insert into public.invoices (kind, order_id, payment_id, provider, is_demo, net_cents, vat_cents, total_cents)
  values ('invoice', v_pay.order_id, v_pay.id, p_provider, p_provider = 'demo', v_net, v_vat, v_total)
  returning id into v_id;
  return query select v_id, true;
end;
$$;

-- ---------------------------------------------------------------------------
-- customer_cancel_order (D33, D38, D137 + D169, D170). New output column refund_ids (one refund row per order of a
-- chain); refund_id = the first of them (a single order: the only one, as before).
--   single order: as before (paid → cancelled with the D33 fee, assigned → review), except a storage order: from
--                 00:00 Europe/Rome of start_date → 55000 storage_started.
--   chain:        only the whole chain, only while every order is 'paid' (no carrier: else 55000 group_in_progress)
--                 and the storage has not started (55000 storage_started). Fee per transport from its own pickup
--                 window; storage refunded in full (D38). Any order of the chain may be clicked.
-- ---------------------------------------------------------------------------
drop function public.customer_cancel_order(uuid, uuid, text);
create function public.customer_cancel_order(p_order_id uuid, p_customer_id uuid, p_reason text default null)
returns table (
  result            text,     -- 'cancelled' | 'review' | 'already_cancelled' | 'already_in_review'
  fee_cents         integer,
  refund_cents      integer,
  refund_id         uuid,
  payment_intent_id text,
  order_number      text,     -- of the root (a single order: its own)
  refund_ids        uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_reason   text := nullif(trim(coalesce(p_reason, '')), '');
  v_order    public.orders%rowtype;
  v_root     public.orders%rowtype;
  v_settings public.settings%rowtype;
  v_pay      public.payments%rowtype;
  v_now      timestamptz := now();
  v_n        integer;
  v_o        record;
  v_fee      integer;
  v_refund   integer;
  v_fee_sum  integer := 0;
  v_ref_sum  integer := 0;
  v_id       uuid;
  v_ids      uuid[] := '{}';
begin
  if v_reason is not null and length(v_reason) > 2000 then
    raise exception 'customer_cancel_order: reason too long' using errcode = '22023', detail = 'reason';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_customer_id and p.role = 'cliente' and not p.is_blocked) then
    raise exception 'customer_cancel_order: not an active customer' using errcode = '42501';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.customer_id is distinct from p_customer_id then
    raise exception 'customer_cancel_order: order not found' using errcode = '22023', detail = 'order';
  end if;
  select * into v_root from public.orders where id = coalesce(v_order.parent_order_id, v_order.id) for update;
  perform 1 from public.orders where parent_order_id = v_root.id order by id for update;
  select count(*) into v_n from public.orders where id = v_root.id or parent_order_id = v_root.id;

  if not exists (select 1 from public.orders where (id = v_root.id or parent_order_id = v_root.id) and status <> 'cancelled') then
    select coalesce(sum(c.cancellation_fee_cents), 0) into v_fee
      from public.order_charges c join public.orders o on o.id = c.order_id
     where o.id = v_root.id or o.parent_order_id = v_root.id;
    return query select 'already_cancelled'::text, v_fee, null::integer, null::uuid, null::text, v_root.order_number, null::uuid[];
    return;
  end if;

  if v_n = 1 and v_root.status = 'cancellation_review' then
    return query select 'already_in_review'::text, null::integer, null::integer, null::uuid, null::text, v_root.order_number, null::uuid[];
    return;
  end if;
  if v_n = 1 and v_root.status = 'assigned' then
    update public.orders
       set status = 'cancellation_review',
           cancellation_requested_at = v_now, cancellation_requested_by = p_customer_id, cancellation_reason = v_reason
     where id = v_root.id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
    values (v_root.id, 'assigned', 'cancellation_review', p_customer_id, 'customer_app', v_now);
    return query select 'review'::text, null::integer, null::integer, null::uuid, null::text, v_root.order_number, null::uuid[];
    return;
  end if;

  if exists (select 1 from public.orders where (id = v_root.id or parent_order_id = v_root.id) and status <> 'paid') then
    raise exception 'customer_cancel_order: cannot be cancelled by the customer'
      using errcode = '55000', detail = case when v_n > 1 then 'group_in_progress' else 'not_cancellable' end;
  end if;
  -- D170: storage starts at 00:00 Europe/Rome of start_date (= orders.pickup_window_start of a storage order).
  if exists (select 1 from public.orders
              where (id = v_root.id or parent_order_id = v_root.id) and service_type = 'storage' and v_now >= pickup_window_start) then
    raise exception 'customer_cancel_order: the storage has started' using errcode = '55000', detail = 'storage_started';
  end if;

  select * into v_settings from public.settings;
  select * into v_pay from public.order_main_payment(v_root.id);
  if v_pay.id is null then
    raise exception 'customer_cancel_order: no succeeded payment' using errcode = '55000', detail = 'no_payment';
  end if;

  for v_o in
    select o.id, o.service_type, o.pickup_window_start, c.total_cents,
           coalesce((select sum(r.amount_cents) from public.refunds r where r.order_id = o.id and r.status <> 'failed'), 0) as refunded
      from public.orders o join public.order_charges c on c.order_id = o.id
     where o.id = v_root.id or o.parent_order_id = v_root.id
     order by o.created_at, o.id
  loop
    v_fee := 0;
    if v_o.service_type <> 'storage'
       and v_now >= v_o.pickup_window_start - make_interval(hours => v_settings.free_cancellation_hours) then
      v_fee := least(public.order_late_cancellation_fee(v_o.id, v_settings.late_cancellation_fee_bp), v_o.total_cents);
    end if;
    v_refund := greatest(v_o.total_cents - v_fee - v_o.refunded, 0)::integer;

    update public.orders
       set status = 'cancelled', cancelled_at = v_now,
           cancellation_requested_at = v_now, cancellation_requested_by = p_customer_id, cancellation_reason = v_reason,
           cancellation_decided_at = v_now, cancellation_decided_by = null      -- automatic (D33), no admin decision
     where id = v_o.id;
    update public.order_charges set cancellation_fee_cents = v_fee where order_id = v_o.id;
    update public.warehouse_bookings set status = 'cancelled' where order_id = v_o.id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
    values (v_o.id, 'paid', 'cancelled', p_customer_id, 'customer_app', v_now);

    if v_refund > 0 then
      insert into public.refunds (order_id, payment_id, kind, amount_cents, reason, created_by, created_at)
      values (v_o.id, v_pay.id, 'customer_cancellation', v_refund, 'customer_cancellation', p_customer_id, v_now)
      returning id into v_id;
      v_ids := v_ids || v_id;
    end if;
    v_fee_sum := v_fee_sum + v_fee;
    v_ref_sum := v_ref_sum + v_refund;
  end loop;

  return query select 'cancelled'::text, v_fee_sum, v_ref_sum, v_ids[1], v_pay.stripe_payment_intent_id, v_root.order_number, v_ids;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_resolve_payment_review (D141) for a chain: the whole group moves together. New output column refund_ids.
--   refund: the remainder of THIS payment split per order — the other orders of the chain first (each ≤ its own
--           remainder), the root last; a single order gets everything as before. A chain paid MORE than its total
--           (overpayment, D141 still open) → 55000 overpaid_chain: the difference is refunded in Stripe by hand.
-- ---------------------------------------------------------------------------
drop function public.admin_resolve_payment_review(uuid, uuid, text);
create function public.admin_resolve_payment_review(p_payment_id uuid, p_admin_id uuid, p_action text)
returns table (
  result            text,      -- 'paid' | 'refunded' | 'already_resolved'
  refund_id         uuid,
  refund_cents      integer,
  payment_intent_id text,
  order_id          uuid,
  order_number      text,
  refund_ids        uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email  text := public.require_admin(p_admin_id);
  v_pay    public.payments%rowtype;
  v_order  public.orders%rowtype;
  v_n      integer;
  v_amount integer;
  v_left   integer;
  v_part   integer;
  v_o      record;
  v_id     uuid;
  v_ids    uuid[] := '{}';
  v_now    timestamptz := now();
begin
  if p_action is null or p_action not in ('mark_paid', 'refund') then
    raise exception 'admin_resolve_payment_review: unknown action' using errcode = '22023', detail = 'action';
  end if;
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found or v_pay.status <> 'succeeded' or v_pay.review_reason is null then
    raise exception 'admin_resolve_payment_review: payment not in review' using errcode = '22023', detail = 'payment';
  end if;
  select * into v_order from public.orders where id = v_pay.order_id for update;
  perform 1 from public.orders where parent_order_id = v_order.id order by id for update;
  select count(*) into v_n from public.orders where id = v_order.id or parent_order_id = v_order.id;
  if v_pay.reviewed_at is not null then
    return query select 'already_resolved'::text, null::uuid, null::integer, v_pay.stripe_payment_intent_id, v_order.id, v_order.order_number, null::uuid[];
    return;
  end if;

  if p_action = 'mark_paid' then
    if v_pay.review_reason = 'duplicate_payment' then
      raise exception 'admin_resolve_payment_review: a duplicate payment can only be refunded' using errcode = '55000', detail = 'duplicate_payment';
    end if;
    if v_order.status <> 'payment_review' then
      raise exception 'admin_resolve_payment_review: order not in payment_review' using errcode = '55000', detail = 'not_in_review';
    end if;
    update public.payments set reviewed_at = v_now, review_outcome = 'accepted' where id = v_pay.id;
    with upd as (
      update public.orders set status = 'paid', paid_at = v_pay.paid_at
       where (id = v_order.id or parent_order_id = v_order.id) and status = 'payment_review'
      returning id
    )
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
    select id, 'payment_review', 'paid', p_admin_id, 'admin_panel', v_now from upd;
    insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
    values (p_admin_id, v_email, 'payment.review_accepted', 'payment', v_pay.id,
            jsonb_build_object('order_id', v_order.id, 'review_reason', v_pay.review_reason));
    return query select 'paid'::text, null::uuid, null::integer, v_pay.stripe_payment_intent_id, v_order.id, v_order.order_number, null::uuid[];
    return;
  end if;

  v_amount := public.payment_refundable_cents(v_pay.id);
  v_left := v_amount;
  update public.payments set reviewed_at = v_now, review_outcome = 'refunded' where id = v_pay.id;
  for v_o in
    select o.id, c.total_cents
           - coalesce((select sum(r.amount_cents) from public.refunds r where r.order_id = o.id and r.status <> 'failed'), 0) as remaining
      from public.orders o join public.order_charges c on c.order_id = o.id
     where o.id = v_order.id or o.parent_order_id = v_order.id
     order by (o.id = v_order.id), o.created_at, o.id                 -- children first, the root last
  loop
    exit when v_left <= 0;
    v_part := case when v_n = 1 then v_left else least(v_left, greatest(v_o.remaining, 0))::integer end;
    if v_part > 0 then
      insert into public.refunds (order_id, payment_id, kind, amount_cents, reason, created_by, created_at)
      values (v_o.id, v_pay.id, 'admin', v_part, 'payment_review', p_admin_id, v_now)
      returning id into v_id;
      v_ids := v_ids || v_id;
      v_left := v_left - v_part;
    end if;
  end loop;
  if v_left > 0 then
    raise exception 'admin_resolve_payment_review: the chain received more than its total' using errcode = '55000', detail = 'overpaid_chain';
  end if;
  if v_order.status = 'payment_review' then
    with upd as (
      update public.orders set status = 'refunded'
       where (id = v_order.id or parent_order_id = v_order.id) and status = 'payment_review'
      returning id
    )
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
    select id, 'payment_review', 'refunded', p_admin_id, 'admin_panel', v_now from upd;
  end if;
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'payment.review_refunded', 'payment', v_pay.id,
          jsonb_build_object('order_id', v_order.id, 'review_reason', v_pay.review_reason, 'refund_cents', v_amount,
                             'refund_id', v_ids[1], 'refund_ids', to_jsonb(v_ids)));
  return query select 'refunded'::text, v_ids[1], v_amount, v_pay.stripe_payment_intent_id, v_order.id, v_order.order_number, v_ids;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_refund_order (D142): as before; the limit is order_refundable_cents() — for an order of a chain at most its
-- own remainder, and "full" means that order fully refunded (only it goes to refunded).
-- ---------------------------------------------------------------------------
create or replace function public.admin_refund_order(p_order_id uuid, p_admin_id uuid, p_amount_cents integer, p_reason_code text)
returns table (
  refund_id         uuid,
  full_refund       boolean,
  new_status        public.order_status,
  payment_intent_id text,
  order_number      text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email      text := public.require_admin(p_admin_id);
  v_order      public.orders%rowtype;
  v_pay        public.payments%rowtype;
  v_refundable integer;
  v_full       boolean;
  v_status     public.order_status;
  v_refund     uuid;
  v_now        timestamptz := now();
begin
  if p_reason_code is null or p_reason_code not in ('service_issue', 'claim', 'goodwill', 'price_correction', 'other') then
    raise exception 'admin_refund_order: unknown reason' using errcode = '22023', detail = 'reason';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'admin_refund_order: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.status not in ('paid', 'assigned', 'picked_up', 'in_transit', 'delivered', 'completed', 'cancelled') then
    raise exception 'admin_refund_order: status % cannot be refunded here', v_order.status using errcode = '55000', detail = 'not_refundable';
  end if;
  select * into v_pay from public.order_main_payment(p_order_id);
  if v_pay.id is null then
    raise exception 'admin_refund_order: no payment' using errcode = '55000', detail = 'no_payment';
  end if;
  perform 1 from public.payments where id = v_pay.id for update;
  v_refundable := public.order_refundable_cents(p_order_id);
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > v_refundable then
    raise exception 'admin_refund_order: amount must be 1–% cents', v_refundable using errcode = '22023', detail = 'amount';
  end if;

  v_full := p_amount_cents = v_refundable;
  v_status := v_order.status;
  if v_full and v_order.status in ('assigned', 'picked_up', 'in_transit') then
    raise exception 'admin_refund_order: unassign the carrier before a full refund' using errcode = '55000', detail = 'in_progress';
  end if;
  if v_full and v_order.status in ('paid', 'delivered', 'completed') then
    v_status := 'refunded';
    update public.orders set status = 'refunded' where id = p_order_id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
    values (p_order_id, v_order.status, 'refunded', p_admin_id, 'admin_panel', v_now);
  end if;

  insert into public.refunds (order_id, payment_id, kind, amount_cents, reason, created_by, created_at)
  values (p_order_id, v_pay.id, 'admin', p_amount_cents, p_reason_code, p_admin_id, v_now)
  returning id into v_refund;
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.refunded', 'order', p_order_id,
          jsonb_build_object('refund_id', v_refund, 'amount_cents', p_amount_cents, 'reason', p_reason_code, 'full', v_full,
                             'from_status', v_order.status, 'to_status', v_status));
  return query select v_refund, v_full, v_status, v_pay.stripe_payment_intent_id, v_order.order_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- customer_order_warehouse(order) (D171): the warehouse of the signed-in customer's own storage order — name and
-- address only (for "porto io" / "ritiro io" and the panel). Customers do not read `warehouses` (RLS); the current
-- address is returned, so a long storage shows the warehouse as it is today. Anything else → no rows.
-- ---------------------------------------------------------------------------
create function public.customer_order_warehouse(p_order_id uuid)
returns table (name text, address text, city text, postal_code text, province text, lat double precision, lng double precision)
language sql
stable
security definer
set search_path = ''
as $$
  select w.name, w.address, w.city, w.postal_code, w.province::text, w.lat, w.lng
  from public.orders o
  join public.warehouse_bookings b on b.order_id = o.id
  join public.warehouses w on w.id = b.warehouse_id
  where o.id = p_order_id
    and o.service_type = 'storage'
    and o.customer_id = auth.uid()
    and public.auth_role() = 'cliente'          -- null for blocked accounts
    and o.status not in ('draft', 'expired', 'cancelled', 'refunded');
$$;

-- ---------------------------------------------------------------------------
-- Privileges: everything above is service role only, except customer_order_warehouse (customer session).
-- ---------------------------------------------------------------------------
revoke execute on function public.order_group_root(uuid) from public, anon, authenticated;
revoke execute on function public.order_refundable_cents(uuid) from public, anon, authenticated;
revoke execute on function public.create_order(jsonb) from public, anon, authenticated;
revoke execute on function public.customer_cancel_order(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_resolve_payment_review(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.customer_order_warehouse(uuid) from public, anon;
grant execute on function public.order_group_root(uuid) to service_role;
grant execute on function public.order_refundable_cents(uuid) to service_role;
grant execute on function public.create_order(jsonb) to service_role;
grant execute on function public.customer_cancel_order(uuid, uuid, text) to service_role;
grant execute on function public.admin_resolve_payment_review(uuid, uuid, text) to service_role;
grant execute on function public.customer_order_warehouse(uuid) to authenticated;
