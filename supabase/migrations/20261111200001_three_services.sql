-- Three services (D151–D157) / migration 2a, part 2: orders of every service type, porter jobs, warehouse
-- capacity and bookings, carriers offering porters.
--
-- Scope of 2a (the rest comes with the step that needs it):
--   * create_service_order(jsonb) creates single Facchinaggio and Deposito orders (service role only);
--     create_order(jsonb) keeps creating transport orders unchanged (service_type defaults to 'transport').
--   * Deposito in 2a: intake 'self', outbound 'self' | 'later', payment 'upfront'. Intake/outbound by Transigo
--     (chain of linked orders, one payment and one invoice, D153) → migration 2b with step 7; monthly plan
--     (D155) → step 10. parent_order_id exists now, always null until 2b.
--   * Carrier side: porters and storage orders have no vehicle type, so list_available_jobs, accept_job,
--     admin_job_candidates and admin_assign_job never match them (they join orders.vehicle_type_id). Porters
--     dispatch to carriers with offers_porters (D152) → step 6. RLS tests prove they stay invisible until then.
--
-- Visibility (D77, same split as transport):
--   order_porter_jobs           customer (own), assigned carrier, admin   (like order_legs)
--   order_porter_carrier_terms  assigned carrier, admin                    (like order_leg_carrier_terms)
--   warehouse_bookings          customer (own), admin — never carriers
--   warehouse_box_capacity      admin

-- ---------------------------------------------------------------------------
-- orders: service type, chain parent, columns that only transport requires
-- ---------------------------------------------------------------------------
alter table public.orders
  add column service_type    public.service_type not null default 'transport',  -- existing orders = transport
  add column parent_order_id uuid references public.orders (id) on delete cascade; -- D153, set only by 2b

alter table public.orders
  alter column vehicle_type_id drop not null,
  alter column pickup_contact_name drop not null,
  alter column pickup_contact_phone drop not null,
  alter column delivery_contact_name drop not null,
  alter column delivery_contact_phone drop not null;

-- transport: vehicle + both contacts (as before); porters: on-site contact in pickup_contact_*, no vehicle,
-- no delivery contact; storage: neither. The old storage columns (model A) belong to transport orders only.
alter table public.orders add constraint orders_service_fields_check check (
  case service_type
    when 'transport' then vehicle_type_id is not null
      and pickup_contact_name is not null and pickup_contact_phone is not null
      and delivery_contact_name is not null and delivery_contact_phone is not null
    when 'porters' then vehicle_type_id is null
      and pickup_contact_name is not null and pickup_contact_phone is not null
      and delivery_contact_name is null and delivery_contact_phone is null
      and storage_type is null and packing_items_count = 0
    when 'storage' then vehicle_type_id is null
      and pickup_contact_name is null and pickup_contact_phone is null
      and delivery_contact_name is null and delivery_contact_phone is null
      and storage_type is null and packing_items_count = 0 and carrier_id is null
  end
);
alter table public.orders add constraint orders_parent_not_self_check check (parent_order_id is distinct from id);

create index orders_parent_idx on public.orders (parent_order_id) where parent_order_id is not null;
create index orders_service_type_idx on public.orders (service_type, status);

-- service_type and parent_order_id are fixed at creation (for everyone).
drop trigger orders_a_forbid_changes on public.orders;
create trigger orders_a_forbid_changes
  before update on public.orders
  for each row execute function public.forbid_column_changes(
    'id', 'order_number', 'customer_id', 'created_at', 'service_type', 'parent_order_id');

-- ---------------------------------------------------------------------------
-- carriers: who offers facchinaggio (D152). Set by the server for admin only — carriers have column-level
-- UPDATE grants on company fields only, so these two are not writable from a carrier session.
-- ---------------------------------------------------------------------------
alter table public.carriers
  add column offers_porters    boolean not null default false,
  add column porters_team_size smallint check (porters_team_size between 2 and 4);
alter table public.carriers add constraint carriers_porters_team_check
  check (offers_porters = (porters_team_size is not null));

-- ---------------------------------------------------------------------------
-- order_porter_jobs — the job of a porters-only order (1:1). Snapshot, like order_legs.
-- ---------------------------------------------------------------------------
create table public.order_porter_jobs (
  order_id               uuid primary key references public.orders (id) on delete cascade,
  address                text not null check (length(trim(address)) between 1 and 500),
  place_id               text,
  lat                    double precision not null check (lat between -90 and 90),
  lng                    double precision not null check (lng between -180 and 180),
  city                   text not null,
  postal_code            text,
  province               char(2) not null check (province ~ '^[A-Z]{2}$'),
  job_date               date not null,                                   -- Europe/Rome date of the window (D73)
  window_start           timestamptz not null,
  window_end             timestamptz not null,
  floor                  smallint not null default 0 check (floor between 0 and 20),
  has_elevator           boolean not null default false,
  persons                smallint not null check (persons between 2 and 4), -- D157 min 2, D54 max 4
  requested_hours        smallint not null check (requested_hours between 1 and 12),
  billed_hours           smallint not null check (billed_hours between 1 and 12), -- max(requested, minimum of the price list)
  is_urgent              boolean not null,                                -- D159, from the engine
  overtime_grace_minutes smallint not null check (overtime_grace_minutes between 0 and 120), -- D68
  worked_minutes         integer check (worked_minutes >= 0),             -- after the job (D69), the only mutable column
  check (window_end > window_start),
  check (billed_hours >= requested_hours)
);

create trigger order_porter_jobs_guard
  before update on public.order_porter_jobs
  for each row execute function public.guard_immutable_columns('worked_minutes');

-- Carrier amount of the porter job (assigned carrier + admin), like order_leg_carrier_terms.
create table public.order_porter_carrier_terms (
  order_id                   uuid primary key references public.order_porter_jobs (order_id) on delete cascade,
  carrier_amount_cents       integer not null check (carrier_amount_cents >= 0),
  porter_share_kind          text check (porter_share_kind in ('percent', 'ratio')),
  porter_share_bp            integer,
  porter_share_carrier_cents integer,
  porter_share_net_cents     integer,
  check (
    (porter_share_kind is null and porter_share_bp is null and porter_share_carrier_cents is null and porter_share_net_cents is null)
    or (porter_share_kind = 'percent' and porter_share_bp between 0 and 10000
        and porter_share_carrier_cents is null and porter_share_net_cents is null)
    or (porter_share_kind = 'ratio' and porter_share_bp is null
        and porter_share_carrier_cents >= 0 and porter_share_net_cents > 0)
  )
);

create trigger order_porter_carrier_terms_guard
  before update on public.order_porter_carrier_terms
  for each row execute function public.guard_immutable_columns();

-- ---------------------------------------------------------------------------
-- Warehouse capacity (D156): boxes per size code, pallet places per warehouse. Admin only.
-- Box codes are the stable codes of price_list_storage_boxes (no FK: codes live per price list version).
-- ---------------------------------------------------------------------------
alter table public.warehouses
  add column pallet_capacity integer not null default 0 check (pallet_capacity between 0 and 100000);

grant insert (pallet_capacity), update (pallet_capacity) on public.warehouses to authenticated; -- admin (RLS)

create table public.warehouse_box_capacity (
  warehouse_id uuid not null references public.warehouses (id) on delete cascade,
  box_code     text not null check (box_code ~ '^[a-z0-9_]{1,20}$'),
  quantity     integer not null check (quantity between 0 and 100000),
  updated_at   timestamptz not null default now(),
  primary key (warehouse_id, box_code)
);

create trigger warehouse_box_capacity_set_updated_at
  before update on public.warehouse_box_capacity
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- warehouse_bookings — what a storage order occupies, and for how long (D154–D156)
-- Days are inclusive: start_date … end_date, days = end_date − start_date + 1 (≥ 1).
-- ---------------------------------------------------------------------------
create table public.warehouse_bookings (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null unique references public.orders (id) on delete cascade,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  unit         public.storage_unit not null,
  box_code     text check (box_code ~ '^[a-z0-9_]{1,20}$'),
  pallets      integer check (pallets between 1 and 100),
  start_date   date not null,
  end_date     date not null,
  payment_plan public.storage_payment_plan not null default 'upfront',
  intake       public.storage_intake not null,
  outbound     public.storage_outbound not null,
  status       public.warehouse_booking_status not null default 'booked',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (end_date >= start_date),
  check ((unit = 'box') = (box_code is not null) and (unit = 'pallet') = (pallets is not null)),
  -- D155: the monthly plan only above 2 months (installments.ts: MONTHLY_PLAN_MIN_DAYS = 61)
  check (payment_plan = 'upfront' or end_date - start_date + 1 >= 61)
);

create index warehouse_bookings_occupancy_idx on public.warehouse_bookings (warehouse_id, unit, start_date, end_date)
  where status in ('booked', 'in_storage');

-- Only the status changes (step 9: in magazzino / uscita; step 10 adds the "Prolunga" of end_date).
create trigger warehouse_bookings_a_guard
  before update on public.warehouse_bookings
  for each row execute function public.guard_immutable_columns('status', 'updated_at');

create trigger warehouse_bookings_set_updated_at
  before update on public.warehouse_bookings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- warehouse_free_units(): free boxes of one size / free pallet places over a whole period
-- = capacity − the busiest day of the period. A booking occupies a unit when it is booked or in storage and
-- its order is paid (or still payable: pending_payment before payment_due_at, D88). Goods still in storage
-- after end_date keep occupying their place until released.
-- Service role only (wizard availability); create_service_order() calls it under the warehouse lock.
-- ---------------------------------------------------------------------------
create or replace function public.warehouse_free_units(
  p_warehouse_id uuid, p_unit public.storage_unit, p_box_code text, p_start date, p_end date
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_capacity integer;
  v_busiest  integer;
begin
  if p_start is null or p_end is null or p_end < p_start or p_end - p_start > 3650 then
    raise exception 'warehouse_free_units: invalid period' using errcode = '22023';
  end if;
  if p_unit = 'box' then
    select coalesce((select quantity from public.warehouse_box_capacity
                     where warehouse_id = p_warehouse_id and box_code = p_box_code), 0)
      into v_capacity;
  else
    select coalesce((select pallet_capacity from public.warehouses where id = p_warehouse_id), 0) into v_capacity;
  end if;

  select coalesce(max(used), 0) into v_busiest
  from (
    select d.day, sum(case when b.unit = 'box' then 1 else b.pallets end) as used
    from generate_series(p_start, p_end, interval '1 day') as d(day)
    join public.warehouse_bookings b
      on b.warehouse_id = p_warehouse_id and b.unit = p_unit
     and (p_unit = 'pallet' or b.box_code = p_box_code)
     and b.status in ('booked', 'in_storage')
     and d.day::date >= b.start_date
     and d.day::date <= case when b.status = 'in_storage'
                             then greatest(b.end_date, (now() at time zone 'Europe/Rome')::date)
                             else b.end_date end
    join public.orders o on o.id = b.order_id
     and o.status not in ('draft', 'expired', 'cancelled', 'refunded')
     and (o.status <> 'pending_payment' or o.payment_due_at > now())
    group by d.day
  ) per_day;

  return greatest(v_capacity - v_busiest, 0);
end;
$$;

revoke execute on function public.warehouse_free_units(uuid, public.storage_unit, text, date, date) from public, anon, authenticated;
grant execute on function public.warehouse_free_units(uuid, public.storage_unit, text, date, date) to service_role;

-- ---------------------------------------------------------------------------
-- create_service_order(payload) — the only way to create a Facchinaggio or Deposito order (D77, D151)
-- ---------------------------------------------------------------------------
-- Payload (built by the server from a stored quote, D76):
-- {
--   service_type: 'porters' | 'storage', customer_id, goods_description, customer_notes,
--   site_contact_name, site_contact_phone,                         -- porters only (on-site contact)
--   porter_job: { address, place_id, lat, lng, city, postal_code, province, job_date, window_start, window_end,
--                 floor, has_elevator, persons, requested_hours, billed_hours, is_urgent, overtime_grace_minutes },
--   booking: { warehouse_id, unit, box_code, pallets, start_date, end_date, payment_plan, intake, outbound },
--   charges: { …as create_order… },
--   lines: [ …as create_order… ],
--   porter_terms: { carrier_amount_cents, porter_share_kind, porter_share_bp, porter_share_carrier_cents,
--                   porter_share_net_cents }                          -- porters only
-- }
-- Returns { "id": uuid, "order_number": text }. Errors: 22023 invalid payload, 23P01 no free unit (storage).
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
    -- 2a: no chain and no monthly plan yet (migration 2b / step 10)
    if v_booking ->> 'intake' <> 'self' or v_booking ->> 'outbound' not in ('self', 'later')
       or coalesce(v_booking ->> 'payment_plan', 'upfront') <> 'upfront' then
      raise exception 'create_service_order: intake/outbound by Transigo and monthly payment are not available yet' using errcode = '22023';
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
    -- Midnight in Rome of the first day: reference for the cancellation rules (D33).
    v_start := ((v_booking ->> 'start_date')::date)::timestamp at time zone 'Europe/Rome';

    -- Capacity (D156): one booking at a time per warehouse — the row lock serialises the race for the last unit.
    perform 1 from public.warehouses w
    where w.id = (v_booking ->> 'warehouse_id')::uuid and w.is_active
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

  -- Order ---------------------------------------------------------------------------
  insert into public.orders (
    customer_id, service_type, pickup_window_start, goods_description, customer_notes,
    pickup_contact_name, pickup_contact_phone
  ) values (
    (p ->> 'customer_id')::uuid,
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

  return jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number);
end;
$$;

revoke execute on function public.create_service_order(jsonb) from public, anon, authenticated;
grant execute on function public.create_service_order(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Privileges: browsers read only; the server writes through create_service_order (D77)
-- ---------------------------------------------------------------------------
revoke all on public.order_porter_jobs, public.order_porter_carrier_terms, public.warehouse_bookings,
  public.warehouse_box_capacity from anon, authenticated, service_role;

grant select on public.order_porter_jobs, public.order_porter_carrier_terms, public.warehouse_bookings
  to authenticated, service_role;
grant select, insert, update, delete on public.warehouse_box_capacity to authenticated; -- admin (RLS)
grant select on public.warehouse_box_capacity to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.order_porter_jobs enable row level security;
alter table public.order_porter_carrier_terms enable row level security;
alter table public.warehouse_bookings enable row level security;
alter table public.warehouse_box_capacity enable row level security;

-- Visible whenever the order is visible (customer own, assigned carrier, admin — orders' RLS).
create policy order_porter_jobs_select on public.order_porter_jobs
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_porter_jobs.order_id));

-- Carrier amount: the assigned carrier and admin, never the customer.
create policy order_porter_carrier_terms_select on public.order_porter_carrier_terms
  for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.orders o
      where o.id = order_porter_carrier_terms.order_id
        and o.carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino'
    )
  );

-- Storage bookings: the customer and admin, never carriers.
create policy warehouse_bookings_select on public.warehouse_bookings
  for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.orders o
      where o.id = warehouse_bookings.order_id
        and o.customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente'
    )
  );

create policy warehouse_box_capacity_admin on public.warehouse_box_capacity
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
