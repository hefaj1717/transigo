-- Stage 2b / migration 2: orders (D47, D71, D73–D77)
-- See docs/db-schema.md sections 3.2 (quotes), 3.3, 4 (create_order) and 6.
--
-- RLS works on rows, not columns, so order data is split by who may see it (D77):
--   shared         orders, order_legs, order_status_history  customer (own), assigned carrier, admin
--   customer price order_charges, order_lines                customer (own), admin            (D29)
--   carrier money  order_leg_carrier_terms                   assigned carrier, admin
-- Orders are created only by create_order(jsonb) (SECURITY DEFINER, service role only). INSERT is
-- revoked from every API role (anon, authenticated, service_role); the price/route snapshot is
-- immutable for everyone, service role included (triggers).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.order_status as enum (
  'draft', 'pending_payment', 'expired', 'paid', 'assigned', 'picked_up', 'in_transit',
  'delivered', 'completed', 'cancellation_review', 'cancelled', 'refunded'
);
create type public.status_source as enum ('customer_app', 'carrier_app', 'admin_panel', 'stripe_webhook', 'system_job');
create type public.order_line_type as enum (
  'transport', 'surcharge_urgent', 'surcharge_weekend_holiday', 'surcharge_floors', 'porters', 'packing', 'storage'
);
create type public.carrier_share_group as enum ('transport', 'porters', 'packing', 'none');

-- ---------------------------------------------------------------------------
-- Generic guards
-- ---------------------------------------------------------------------------

-- Snapshot guard: on UPDATE, every column except those passed as trigger arguments must stay the same.
-- Applies to everyone (service role and SQL Editor included).
create or replace function public.guard_immutable_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_new jsonb := to_jsonb(new);
  v_old jsonb := to_jsonb(old);
  col text;
begin
  if tg_nargs > 0 then
    foreach col in array tg_argv loop
      v_new := v_new - col;
      v_old := v_old - col;
    end loop;
  end if;
  if v_new is distinct from v_old then
    raise exception '%: order snapshot is immutable', tg_table_name using errcode = '42501';
  end if;
  return new;
end;
$$;

-- On UPDATE, the columns passed as trigger arguments must stay the same (for everyone).
create or replace function public.forbid_column_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  col text;
begin
  foreach col in array tg_argv loop
    if (to_jsonb(new) -> col) is distinct from (to_jsonb(old) -> col) then
      raise exception 'Column %.% cannot be changed', tg_table_name, col using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

-- Append-only tables: any UPDATE or TRUNCATE is rejected (for everyone).
create or replace function public.reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%: rows are append-only', tg_table_name using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- quotes — wizard quotes kept by the server (D76). Service role only.
-- ---------------------------------------------------------------------------
create table public.quotes (
  id            uuid primary key default gen_random_uuid(),
  price_list_id uuid not null references public.price_lists (id) on delete cascade,
  customer_type public.customer_type not null,
  input         jsonb not null check (jsonb_typeof(input) = 'object'),  -- wizard data + places/routes resolved by the server
  quote         jsonb not null check (jsonb_typeof(quote) = 'object'),  -- full Quote, carrier amounts included
  created_at    timestamptz not null default now(),
  valid_until   timestamptz not null check (valid_until > created_at)
);

create index quotes_created_at_idx on public.quotes (created_at); -- cleanup of rows older than 24 h

-- ---------------------------------------------------------------------------
-- orders — shared order data
-- ---------------------------------------------------------------------------
create sequence public.order_number_seq;

create table public.orders (
  id                     uuid primary key default gen_random_uuid(),
  order_number           text not null unique,                                      -- D71, set by trigger
  customer_id            uuid not null references public.customers (profile_id) on delete restrict, -- D77
  status                 public.order_status not null default 'pending_payment',    -- D77
  vehicle_type_id        uuid not null references public.vehicle_types (id),
  pickup_window_start    timestamptz not null,                                      -- copy of leg 0 (D33 reference)
  -- goods
  goods_description      text not null check (length(trim(goods_description)) between 1 and 2000),
  items_count            integer check (items_count > 0),
  weight_kg              integer check (weight_kg > 0),
  goods_dimensions_note  text check (length(goods_dimensions_note) <= 500),
  -- services (porters per leg: order_legs, D74)
  packing_items_count    integer not null default 0 check (packing_items_count between 0 and 500),
  storage_type           public.storage_type,
  storage_billing_unit   public.storage_billing_unit,
  storage_days           integer check (storage_days >= 0),
  storage_pallets        integer check (storage_pallets > 0),
  warehouse_id           uuid references public.warehouses (id),
  -- contacts (pickup at A, delivery at B)
  pickup_contact_name    text not null check (length(trim(pickup_contact_name)) between 1 and 200),
  pickup_contact_phone   text not null check (length(trim(pickup_contact_phone)) between 1 and 40),
  delivery_contact_name  text not null check (length(trim(delivery_contact_name)) between 1 and 200),
  delivery_contact_phone text not null check (length(trim(delivery_contact_phone)) between 1 and 40),
  customer_notes         text check (length(customer_notes) <= 2000),
  -- execution (Stage 3+)
  carrier_id             uuid references public.carriers (profile_id) on delete restrict, -- D75: per order
  carrier_vehicle_id     uuid references public.carrier_vehicles (id),
  paid_at                timestamptz,                                               -- Stripe webhook only
  assigned_at            timestamptz,
  picked_up_at           timestamptz,
  in_transit_at          timestamptz,
  delivered_at           timestamptz,
  completed_at           timestamptz,
  cancelled_at           timestamptz,
  tracking_token         text unique,                                               -- D24
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- storage: all core fields or none; pallets with pallet_day; 0 days = transshipment
  check (
    (storage_type is null) = (warehouse_id is null)
    and (storage_type is null) = (storage_days is null)
    and (storage_type is null) = (storage_billing_unit is null)
  ),
  check (storage_pallets is null or storage_type is not null),
  check (storage_billing_unit is distinct from 'pallet_day' or storage_pallets is not null),
  check (storage_type is null or (storage_type = 'transshipment') = (storage_days = 0)),
  check (status not in ('paid', 'assigned', 'picked_up', 'in_transit', 'delivered', 'completed') or paid_at is not null),
  check (status not in ('assigned', 'picked_up', 'in_transit', 'delivered', 'completed', 'cancellation_review') or carrier_id is not null)
);

create index orders_customer_idx on public.orders (customer_id, created_at desc);
create index orders_carrier_idx on public.orders (carrier_id, status);
create index orders_status_pickup_idx on public.orders (status, pickup_window_start);

-- D71: TG-YYYY-NNNNNN (year in Europe/Rome, one global sequence, longer when > 999 999)
create or replace function public.set_order_number()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  n bigint := nextval('public.order_number_seq');
begin
  new.order_number := 'TG-' || to_char(now() at time zone 'Europe/Rome', 'YYYY') || '-'
    || lpad(n::text, greatest(6, length(n::text)), '0');
  return new;
end;
$$;

create trigger orders_set_number
  before insert on public.orders
  for each row execute function public.set_order_number();

create trigger orders_a_forbid_changes
  before update on public.orders
  for each row execute function public.forbid_column_changes('id', 'order_number', 'customer_id', 'created_at');

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- Only unpaid orders can be deleted (for everyone); deletion cascades to the snapshot tables (D77).
create or replace function public.guard_order_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status not in ('draft', 'pending_payment', 'expired') then
    raise exception 'Only unpaid orders can be deleted (status %)', old.status using errcode = '42501';
  end if;
  return old;
end;
$$;

create trigger orders_guard_delete
  before delete on public.orders
  for each row execute function public.guard_order_delete();

-- ---------------------------------------------------------------------------
-- order_legs — 1 leg, or 2 with storage: A→warehouse, warehouse→B (D47)
-- ---------------------------------------------------------------------------
create table public.order_legs (
  order_id                      uuid not null references public.orders (id) on delete cascade,
  leg_index                     smallint not null check (leg_index between 0 and 1),
  pickup_address                text not null,
  pickup_place_id               text,
  pickup_lat                    double precision not null check (pickup_lat between -90 and 90),
  pickup_lng                    double precision not null check (pickup_lng between -180 and 180),
  pickup_city                   text not null,
  pickup_postal_code            text,
  pickup_province               char(2) not null check (pickup_province ~ '^[A-Z]{2}$'),
  pickup_warehouse_id           uuid references public.warehouses (id),
  delivery_address              text not null,
  delivery_place_id             text,
  delivery_lat                  double precision not null check (delivery_lat between -90 and 90),
  delivery_lng                  double precision not null check (delivery_lng between -180 and 180),
  delivery_city                 text not null,
  delivery_postal_code          text,
  delivery_province             char(2) check (delivery_province ~ '^[A-Z]{2}$'),
  delivery_warehouse_id         uuid references public.warehouses (id),
  distance_m                    integer not null check (distance_m > 0),
  duration_s                    integer check (duration_s >= 0),
  pickup_date                   date not null,                                    -- Europe/Rome date of the window
  pickup_window_start           timestamptz not null,
  pickup_window_end             timestamptz not null,
  pickup_floor                  smallint not null default 0 check (pickup_floor between 0 and 20),
  pickup_has_elevator           boolean not null default false,
  delivery_floor                smallint not null default 0 check (delivery_floor between 0 and 20),
  delivery_has_elevator         boolean not null default false,
  is_urgent                     boolean not null,                                 -- D49, from the engine
  -- porters of this leg (D74), snapshot of Quote.porters[] (D68)
  porter_package_code           public.porter_package_code,
  porters_count                 smallint not null default 0,
  porters_included_hours        smallint,
  porter_overtime_grace_minutes smallint,
  porters_worked_minutes        integer check (porters_worked_minutes >= 0),       -- Stage 4 (D69), the only mutable column
  primary key (order_id, leg_index),
  check (pickup_window_end > pickup_window_start),
  check (pickup_warehouse_id is null or delivery_warehouse_id is null),
  check (
    (porter_package_code is null and porters_count = 0 and porters_included_hours is null and porter_overtime_grace_minutes is null)
    or (porter_package_code is not null and porters_count between 1 and 4
        and porters_included_hours between 1 and 8 and porter_overtime_grace_minutes between 0 and 120)
  )
);

create trigger order_legs_guard
  before update on public.order_legs
  for each row execute function public.guard_immutable_columns('porters_worked_minutes');

-- ---------------------------------------------------------------------------
-- order_charges — customer price, 1:1 (customer + admin)
-- ---------------------------------------------------------------------------
create table public.order_charges (
  order_id                   uuid primary key references public.orders (id) on delete cascade,
  price_list_id              uuid not null references public.price_lists (id) on delete restrict,
  price_list_version         integer not null,
  customer_type              public.customer_type not null,                      -- D3 snapshot
  vat_rate_bp                integer not null check (vat_rate_bp between 0 and 10000),
  subtotal_cents             integer not null check (subtotal_cents >= 0),       -- net
  vat_cents                  integer not null check (vat_cents >= 0),
  total_cents                integer not null check (total_cents >= 0),          -- gross = amount charged in Stripe
  porter_overtime_rate_cents integer check (porter_overtime_rate_cents >= 0),    -- D68, per person per started hour
  refunded_cents             integer not null default 0,                         -- the only mutable amount (Stage 3)
  billing_details            jsonb not null check (jsonb_typeof(billing_details) = 'object'), -- D36, D43, D44
  terms_accepted_at          timestamptz not null,
  terms_version              text not null check (length(trim(terms_version)) > 0),
  quoted_at                  timestamptz not null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  check (total_cents = subtotal_cents + vat_cents),
  check (refunded_cents between 0 and total_cents)
);

create trigger order_charges_a_guard
  before update on public.order_charges
  for each row execute function public.guard_immutable_columns('refunded_cents', 'updated_at');

create trigger order_charges_set_updated_at
  before update on public.order_charges
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- order_lines — customer price breakdown (customer + admin)
-- ---------------------------------------------------------------------------
create table public.order_lines (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.orders (id) on delete cascade,
  sort_order          smallint not null check (sort_order >= 0),
  leg_index           smallint check (leg_index between 0 and 1),                -- null = storage
  line_type           public.order_line_type not null,
  label_it            text not null check (length(trim(label_it)) between 1 and 300),
  quantity            integer not null check (quantity > 0),
  unit_amount_cents   integer check (unit_amount_cents >= 0),
  net_cents           integer not null check (net_cents >= 0),
  vat_cents           integer not null check (vat_cents >= 0),
  gross_cents         integer not null check (gross_cents >= 0),
  carrier_share_group public.carrier_share_group not null,
  unique (order_id, sort_order),
  check (gross_cents = net_cents + vat_cents),
  check ((line_type = 'storage') = (leg_index is null))
);

create index order_lines_order_idx on public.order_lines (order_id);

create trigger order_lines_guard
  before update on public.order_lines
  for each row execute function public.guard_immutable_columns();

-- ---------------------------------------------------------------------------
-- order_leg_carrier_terms — carrier amounts per leg (assigned carrier + admin)
-- ---------------------------------------------------------------------------
create table public.order_leg_carrier_terms (
  order_id                   uuid not null,
  leg_index                  smallint not null,
  carrier_amount_cents       integer not null check (carrier_amount_cents >= 0),
  transport_carrier_cents    integer not null default 0 check (transport_carrier_cents >= 0),
  porters_carrier_cents      integer not null default 0 check (porters_carrier_cents >= 0),
  packing_carrier_cents      integer not null default 0 check (packing_carrier_cents >= 0),
  -- carrier share for porter overtime (D68, QuotePorters.carrierShare); null = no porters or share disabled
  porter_share_kind          text check (porter_share_kind in ('percent', 'ratio')),
  porter_share_bp            integer,
  porter_share_carrier_cents integer,
  porter_share_net_cents     integer,
  primary key (order_id, leg_index),
  foreign key (order_id, leg_index) references public.order_legs (order_id, leg_index) on delete cascade,
  check (carrier_amount_cents = transport_carrier_cents + porters_carrier_cents + packing_carrier_cents),
  check (
    (porter_share_kind is null and porter_share_bp is null and porter_share_carrier_cents is null and porter_share_net_cents is null)
    or (porter_share_kind = 'percent' and porter_share_bp between 0 and 10000
        and porter_share_carrier_cents is null and porter_share_net_cents is null)
    or (porter_share_kind = 'ratio' and porter_share_bp is null
        and porter_share_carrier_cents >= 0 and porter_share_net_cents > 0)
  )
);

create trigger order_leg_carrier_terms_guard
  before update on public.order_leg_carrier_terms
  for each row execute function public.guard_immutable_columns();

-- ---------------------------------------------------------------------------
-- order_status_history — append-only
-- ---------------------------------------------------------------------------
create table public.order_status_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders (id) on delete cascade,
  from_status public.order_status,
  to_status   public.order_status not null,
  changed_by  uuid,                         -- no FK: the row must survive account deletion (append-only, like audit_log)
  source      public.status_source not null,
  note        text check (length(note) <= 2000), -- visible to the order's parties; internal admin reasons → audit_log
  lat         double precision check (lat between -90 and 90),
  lng         double precision check (lng between -180 and 180),
  created_at  timestamptz not null default now()
);

create index order_status_history_order_idx on public.order_status_history (order_id, created_at);

create trigger order_status_history_no_update
  before update on public.order_status_history
  for each row execute function public.reject_change();

create trigger order_status_history_no_truncate
  before truncate on public.order_status_history
  for each statement execute function public.reject_change();

-- ---------------------------------------------------------------------------
-- create_order(payload) — the only way to create an order (D77)
-- ---------------------------------------------------------------------------
-- Payload (built by the server from a stored quote, D76):
-- {
--   customer_id, vehicle_type_id, goods_description, items_count, weight_kg, goods_dimensions_note,
--   packing_items_count, pickup_contact_name, pickup_contact_phone, delivery_contact_name,
--   delivery_contact_phone, customer_notes,
--   storage: null | { storage_type, storage_billing_unit, storage_days, storage_pallets, warehouse_id },
--   legs: [{ leg_index, pickup_* / delivery_* address columns, pickup_warehouse_id, delivery_warehouse_id,
--            distance_m, duration_s, pickup_date, pickup_window_start, pickup_window_end, floors/elevators,
--            is_urgent, porter_package_code, porters_count, porters_included_hours, porter_overtime_grace_minutes }],
--   charges: { price_list_id, price_list_version, customer_type, vat_rate_bp, subtotal_cents, vat_cents,
--              total_cents, porter_overtime_rate_cents, billing_details, terms_accepted_at, terms_version, quoted_at },
--   lines: [{ sort_order, leg_index, line_type, label_it, quantity, unit_amount_cents, net_cents, vat_cents,
--             gross_cents, carrier_share_group }],
--   carrier_terms: [{ leg_index, carrier_amount_cents, transport_carrier_cents, porters_carrier_cents,
--                     packing_carrier_cents, porter_share_kind, porter_share_bp, porter_share_carrier_cents,
--                     porter_share_net_cents }]
-- }
-- Returns { "id": uuid, "order_number": text }.
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
    goods_description, items_count, weight_kg, goods_dimensions_note, packing_items_count,
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

-- ---------------------------------------------------------------------------
-- Privileges: browsers read only; the server writes through create_order (D77)
-- ---------------------------------------------------------------------------
revoke all on public.orders, public.order_legs, public.order_charges, public.order_lines,
  public.order_leg_carrier_terms, public.order_status_history, public.quotes
  from anon, authenticated, service_role;

grant select on public.orders, public.order_legs, public.order_charges, public.order_lines,
  public.order_leg_carrier_terms, public.order_status_history
  to authenticated, service_role;

-- Server: status changes and deleting unpaid orders (guarded by triggers); refunds (Stage 3).
grant update, delete on public.orders to service_role;
grant update (refunded_cents) on public.order_charges to service_role;
grant select, insert, delete on public.quotes to service_role;

revoke all on sequence public.order_number_seq from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.quotes enable row level security; -- no policies: service role only (D76)
alter table public.orders enable row level security;
alter table public.order_legs enable row level security;
alter table public.order_charges enable row level security;
alter table public.order_lines enable row level security;
alter table public.order_leg_carrier_terms enable row level security;
alter table public.order_status_history enable row level security;

-- orders: own (customer), assigned (carrier), all (admin). Blocked accounts: auth_role() is null.
create policy orders_select_customer on public.orders
  for select to authenticated
  using (customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente');

create policy orders_select_carrier on public.orders
  for select to authenticated
  using (carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino');

create policy orders_select_admin on public.orders
  for select to authenticated
  using ((select public.is_admin()));

-- Shared child tables: visible whenever the order is visible (the subquery runs under orders' RLS).
create policy order_legs_select on public.order_legs
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_legs.order_id));

create policy order_status_history_select on public.order_status_history
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_status_history.order_id));

-- Customer price: the customer and admin, never the carrier (D29).
create policy order_charges_select on public.order_charges
  for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.orders o
      where o.id = order_charges.order_id
        and o.customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente'
    )
  );

create policy order_lines_select on public.order_lines
  for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.orders o
      where o.id = order_lines.order_id
        and o.customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente'
    )
  );

-- Carrier amounts: the assigned carrier and admin, never the customer.
create policy order_leg_carrier_terms_select on public.order_leg_carrier_terms
  for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.orders o
      where o.id = order_leg_carrier_terms.order_id
        and o.carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino'
    )
  );
