-- D182 (docs/plany/carico-scarico.md): help at loading and at unloading, each with its own persons and hours.
--
--   * order_legs: loading_porters / loading_hours (pickup side) and unloading_porters / unloading_hours (delivery
--     side), snapshot like the rest of the leg. A leg has EITHER the package porters of D67/D74 (porters_count,
--     same team loads and unloads) OR loading / unloading help — never both. porter_overtime_grace_minutes is
--     set whenever the leg has any porters.
--   * loading_worked_minutes / unloading_worked_minutes: measured time per side, written ONLY by the database when
--     the delivery proof is recorded (trigger on delivery_proofs), like porters_worked_minutes (D69).
--   * order_loading_help_minutes(order): the time per side, computed only here — loading = loaded − arrived_pickup,
--     unloading = unloaded − arrived_delivery, rounded DOWN to full minutes.
--   * create_transport_order: writes the new columns; list_available_jobs: shows them (no personal data).
-- Existing orders keep the package columns unchanged.

-- ---------------------------------------------------------------------------
-- Columns and the porters check (replaces the package-only check of the orders migration)
-- ---------------------------------------------------------------------------
alter table public.order_legs
  add column loading_porters          smallint not null default 0 check (loading_porters between 0 and 4),
  add column loading_hours            smallint check (loading_hours between 1 and 4),
  add column unloading_porters        smallint not null default 0 check (unloading_porters between 0 and 4),
  add column unloading_hours          smallint check (unloading_hours between 1 and 4),
  add column loading_worked_minutes   integer check (loading_worked_minutes >= 0),
  add column unloading_worked_minutes integer check (unloading_worked_minutes >= 0);

do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.order_legs'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%porter_package_code IS NULL%porter_overtime_grace_minutes%';
  if v_name is null then
    raise exception 'order_legs porters check not found';
  end if;
  execute format('alter table public.order_legs drop constraint %I', v_name);
end;
$$;

alter table public.order_legs add constraint order_legs_porters_check check (
  (
    (porter_package_code is null and porters_count = 0 and porters_included_hours is null)
    or (porter_package_code is not null and porters_count between 1 and 4 and porters_included_hours between 1 and 8
        and loading_porters = 0 and unloading_porters = 0)
  )
  and ((loading_porters = 0) = (loading_hours is null))
  and ((unloading_porters = 0) = (unloading_hours is null))
  and ((porters_count + loading_porters + unloading_porters = 0) = (porter_overtime_grace_minutes is null))
  and (porter_overtime_grace_minutes is null or porter_overtime_grace_minutes between 0 and 120)
);

drop trigger order_legs_guard on public.order_legs;
create trigger order_legs_guard
  before update on public.order_legs
  for each row execute function public.guard_immutable_columns(
    'porters_worked_minutes', 'early_start_allowed_at', 'loading_worked_minutes', 'unloading_worked_minutes');

-- ---------------------------------------------------------------------------
-- order_loading_help_minutes(order): working time per side of the legs with loading / unloading help (D182),
-- computed ONLY here. SECURITY INVOKER: a session sees only the steps its RLS allows.
-- ---------------------------------------------------------------------------
create function public.order_loading_help_minutes(p_order_id uuid)
returns table (leg_index smallint, side text, worked_minutes integer, complete boolean)
language sql
stable
set search_path = ''
as $$
  with s as (
    select x.leg_index, x.step, x.created_at
    from public.order_leg_steps x
    where x.order_id = p_order_id and x.reverted_at is null
  ), t as (
    select l.leg_index, l.loading_porters, l.unloading_porters,
           max(s.created_at) filter (where s.step = 'arrived_pickup') as ap,
           max(s.created_at) filter (where s.step = 'loaded') as lo,
           max(s.created_at) filter (where s.step = 'arrived_delivery') as ad,
           max(s.created_at) filter (where s.step = 'unloaded') as un
    from public.order_legs l
    left join s on s.leg_index = l.leg_index
    where l.order_id = p_order_id and (l.loading_porters > 0 or l.unloading_porters > 0)
    group by l.leg_index, l.loading_porters, l.unloading_porters
  )
  select t.leg_index, 'loading'::text,
         floor(extract(epoch from coalesce(t.lo - t.ap, interval '0')) / 60)::integer,
         (t.ap is not null and t.lo is not null)
  from t where t.loading_porters > 0
  union all
  select t.leg_index, 'unloading'::text,
         floor(extract(epoch from coalesce(t.un - t.ad, interval '0')) / 60)::integer,
         (t.ad is not null and t.un is not null)
  from t where t.unloading_porters > 0
  order by 1, 2;
$$;
revoke execute on function public.order_loading_help_minutes(uuid) from public, anon;
grant execute on function public.order_loading_help_minutes(uuid) to authenticated, service_role;

-- The measured time is stored with the delivery proof (complete_delivery inserts it), like porters_worked_minutes.
create function public.store_loading_help_minutes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.order_legs l
     set loading_worked_minutes   = case when l.loading_porters > 0 then coalesce(
           (select m.worked_minutes from public.order_loading_help_minutes(new.order_id) m where m.leg_index = l.leg_index and m.side = 'loading'), 0) end,
         unloading_worked_minutes = case when l.unloading_porters > 0 then coalesce(
           (select m.worked_minutes from public.order_loading_help_minutes(new.order_id) m where m.leg_index = l.leg_index and m.side = 'unloading'), 0) end
   where l.order_id = new.order_id and (l.loading_porters > 0 or l.unloading_porters > 0);
  return new;
end;
$$;
revoke execute on function public.store_loading_help_minutes() from public, anon, authenticated;

create trigger delivery_proofs_store_loading_help
  after insert on public.delivery_proofs
  for each row execute function public.store_loading_help_minutes();

-- ---------------------------------------------------------------------------
-- create_transport_order: + loading / unloading help (body otherwise as in 20261112120000_shipment_category.sql)
-- ---------------------------------------------------------------------------
create or replace function public.create_transport_order(p jsonb, p_parent_order_id uuid, p_chain_role text, p_warehouse_id uuid)
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
    largest_item_length_cm, largest_item_width_cm, largest_item_height_cm, pallets_count, load_category, shipment_category, stackable,
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
    (p ->> 'shipment_category')::public.shipment_category,
    (p ->> 'stackable')::boolean,
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
    porter_package_code, porters_count, porters_included_hours, porter_overtime_grace_minutes,
    loading_porters, loading_hours, unloading_porters, unloading_hours
  )
  select
    v_order.id, l.leg_index,
    l.pickup_address, l.pickup_place_id, l.pickup_lat, l.pickup_lng, l.pickup_city, l.pickup_postal_code, l.pickup_province, l.pickup_warehouse_id,
    l.delivery_address, l.delivery_place_id, l.delivery_lat, l.delivery_lng, l.delivery_city, l.delivery_postal_code, l.delivery_province, l.delivery_warehouse_id,
    l.distance_m, l.duration_s, l.pickup_date, l.pickup_window_start, l.pickup_window_end,
    coalesce(l.pickup_floor, 0), coalesce(l.pickup_has_elevator, false), coalesce(l.delivery_floor, 0), coalesce(l.delivery_has_elevator, false), l.is_urgent,
    l.porter_package_code, coalesce(l.porters_count, 0), l.porters_included_hours, l.porter_overtime_grace_minutes,
    coalesce(l.loading_porters, 0), l.loading_hours, coalesce(l.unloading_porters, 0), l.unloading_hours
  from jsonb_to_recordset(v_legs) as l(
    leg_index smallint,
    pickup_address text, pickup_place_id text, pickup_lat double precision, pickup_lng double precision,
    pickup_city text, pickup_postal_code text, pickup_province char(2), pickup_warehouse_id uuid,
    delivery_address text, delivery_place_id text, delivery_lat double precision, delivery_lng double precision,
    delivery_city text, delivery_postal_code text, delivery_province char(2), delivery_warehouse_id uuid,
    distance_m integer, duration_s integer, pickup_date date, pickup_window_start timestamptz, pickup_window_end timestamptz,
    pickup_floor smallint, pickup_has_elevator boolean, delivery_floor smallint, delivery_has_elevator boolean, is_urgent boolean,
    porter_package_code public.porter_package_code, porters_count smallint, porters_included_hours smallint,
    porter_overtime_grace_minutes smallint,
    loading_porters smallint, loading_hours smallint, unloading_porters smallint, unloading_hours smallint
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

  -- porters on a leg (package, or loading / unloading help — D182) ⇔ a porters line for that leg (D74)
  select count(*) into v_bad
  from public.order_legs l
  where l.order_id = v_order.id
    and (l.porter_package_code is not null or l.loading_porters > 0 or l.unloading_porters > 0) <> exists (
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
    where t.order_id = v_order.id and t.porter_share_kind is not null
      and l.porter_package_code is null and l.loading_porters = 0 and l.unloading_porters = 0 -- D182
  ) then
    raise exception 'create_order: porter share on a leg without porters' using errcode = '22023';
  end if;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source)
  values (v_order.id, null, v_order.status, v_order.customer_id, 'customer_app');

  return jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- list_available_jobs: + loading / unloading help in the legs (body otherwise as in 20261110100000_carrier_jobs.sql)
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
                   'loading_porters', l.loading_porters, 'loading_hours', l.loading_hours,
                   'unloading_porters', l.unloading_porters, 'unloading_hours', l.unloading_hours,
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
