-- Stage 2b+ : vehicle recommendation (D81–D86)
--   * vehicle_types.euro_pallets + placeholder capacities (only where empty: admin edits are kept)
--   * porter_package_min_vehicle: minimum vehicle per load category (admin only, not versioned — D83)
--   * orders: goods snapshot for the vehicle check (largest item, pallets, load category — D86)
--   * create_order(): accepts the new goods fields
-- See docs/spec.md D81–D87, docs/db-schema.md.

-- ---------------------------------------------------------------------------
-- vehicle_types: EUR pallets + placeholder capacities (D81)
-- ---------------------------------------------------------------------------
alter table public.vehicle_types
  add column euro_pallets smallint check (euro_pallets >= 0);

-- Placeholders to be confirmed with carriers. coalesce: never overwrite values already set by the admin.
update public.vehicle_types v
   set payload_kg       = coalesce(v.payload_kg, p.payload_kg),
       cargo_length_cm  = coalesce(v.cargo_length_cm, p.length_cm),
       cargo_width_cm   = coalesce(v.cargo_width_cm, p.width_cm),
       cargo_height_cm  = coalesce(v.cargo_height_cm, p.height_cm),
       cargo_volume_dm3 = coalesce(v.cargo_volume_dm3, p.volume_dm3),
       euro_pallets     = coalesce(v.euro_pallets, p.euro_pallets)
  from (values
    ('car',              400, 150, 100,  80,  1200,  0),
    ('van_small',        750, 180, 140, 125,  3000,  2),
    ('van_medium',      1200, 300, 170, 180,  9000,  4),
    ('van_large',       1000, 420, 205, 220, 19000,  8),
    ('truck_tail_lift', 3000, 600, 240, 240, 34500, 15)
  ) as p (code, payload_kg, length_cm, width_cm, height_cm, volume_dm3, euro_pallets)
 where v.code = p.code;

-- ---------------------------------------------------------------------------
-- porter_package_min_vehicle (D83)
-- ---------------------------------------------------------------------------
create table public.porter_package_min_vehicle (
  package_code    public.porter_package_code primary key,
  vehicle_type_id uuid not null references public.vehicle_types (id) on delete restrict,
  updated_at      timestamptz not null default now()
);

create trigger porter_package_min_vehicle_set_updated_at
  before update on public.porter_package_min_vehicle
  for each row execute function public.set_updated_at();

-- Placeholders: parcels — no minimum; monolocale → furgone medio; bilocale, trilocale_plus → furgone grande.
insert into public.porter_package_min_vehicle (package_code, vehicle_type_id)
select m.package_code::public.porter_package_code, vt.id
  from (values ('monolocale', 'van_medium'), ('bilocale', 'van_large'), ('trilocale_plus', 'van_large')) as m (package_code, code)
  join public.vehicle_types vt on vt.code = m.code
on conflict (package_code) do nothing;

revoke all on public.porter_package_min_vehicle from anon, authenticated;
grant select, insert, update, delete on public.porter_package_min_vehicle to authenticated;

alter table public.porter_package_min_vehicle enable row level security;

create policy porter_package_min_vehicle_select_admin on public.porter_package_min_vehicle
  for select to authenticated using ((select public.is_admin()));
create policy porter_package_min_vehicle_insert_admin on public.porter_package_min_vehicle
  for insert to authenticated with check ((select public.is_admin()));
create policy porter_package_min_vehicle_update_admin on public.porter_package_min_vehicle
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy porter_package_min_vehicle_delete_admin on public.porter_package_min_vehicle
  for delete to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- orders: goods snapshot (D86)
-- ---------------------------------------------------------------------------
alter table public.orders
  add column largest_item_length_cm integer check (largest_item_length_cm > 0),
  add column largest_item_width_cm  integer check (largest_item_width_cm > 0),
  add column largest_item_height_cm integer check (largest_item_height_cm > 0),
  add column pallets_count          integer check (pallets_count > 0),
  add column load_category          public.porter_package_code; -- D83; null = not a move

-- ---------------------------------------------------------------------------
-- create_order(): same as 20261108230001_orders.sql plus the goods fields above
-- ---------------------------------------------------------------------------
create or replace function public.create_order(p jsonb)
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
    customer_id, vehicle_type_id, pickup_window_start,
    goods_description, items_count, weight_kg, goods_dimensions_note,
    largest_item_length_cm, largest_item_width_cm, largest_item_height_cm, pallets_count, load_category,
    packing_items_count,
    storage_type, storage_billing_unit, storage_days, storage_pallets, warehouse_id,
    pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone, customer_notes
  ) values (
    (p ->> 'customer_id')::uuid,
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
  if v_storage is not null then
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

revoke execute on function public.create_order(jsonb) from public, anon, authenticated;
grant execute on function public.create_order(jsonb) to service_role;
