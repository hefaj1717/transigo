-- Stage 2a / migration 1: versioned price lists (rates per vehicle type, pricing rules)
-- See docs/db-schema.md section 3.2 and decisions D18, D47–D60 in docs/spec.md.
--
-- Security model (D59, D60):
--   * Price tables are admin-only (they hold carrier shares = Transigo margin, D29).
--     Quotes are computed by the server, which reads the active list with the service role.
--   * Only drafts are editable. active/archived lists and their rates/rules are immutable for everyone
--     (including the service role); the only allowed status changes are draft→active and active→archived.
--   * New versions are created with clone_price_list() and published with publish_price_list()
--     (SECURITY DEFINER, admin only). Status/version columns are not granted to API users.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.price_list_status as enum ('draft', 'active', 'archived');
create type public.price_rule_kind as enum ('fixed', 'percent', 'per_unit');
create type public.storage_type as enum ('transshipment', 'short_term', 'long_term');
create type public.storage_billing_unit as enum ('day', 'pallet_day');
create type public.price_rule_code as enum (
  'surcharge_urgent',            -- D49, per leg
  'surcharge_weekend_holiday',   -- D51, per leg
  'surcharge_floor_no_elevator', -- D53, per floor without elevator
  'porter_hour',                 -- D54, per person-hour
  'packing_flat',                -- D54, per order
  'packing_per_item',            -- D54, per item
  'storage_day',                 -- D55, short term, per day
  'storage_pallet_day',          -- D55, short term, per pallet-day
  'storage_day_long',            -- D55, days above the short-term threshold, per day
  'storage_pallet_day_long',     -- D55, days above the short-term threshold, per pallet-day
  'transshipment_flat',          -- D55, 0 days in the warehouse
  'carrier_share_transport',     -- D6, D14, D57
  'carrier_share_porters',
  'carrier_share_packing'
);

-- ---------------------------------------------------------------------------
-- price_lists
-- ---------------------------------------------------------------------------
create table public.price_lists (
  id                          uuid primary key default gen_random_uuid(),
  version                     integer not null unique check (version > 0),
  status                      public.price_list_status not null default 'draft',
  vat_rate_bp                 integer not null default 2200 check (vat_rate_bp between 0 and 10000),
  urgent_lead_hours           integer not null default 24 check (urgent_lead_hours between 1 and 720),       -- D49
  storage_short_term_max_days integer not null default 30 check (storage_short_term_max_days between 1 and 3650), -- D55
  storage_billing_unit        public.storage_billing_unit not null default 'pallet_day',                     -- D55
  notes                       text,
  published_at                timestamptz,
  published_by                uuid references public.profiles (id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  check ((status = 'draft') = (published_at is null))
);

-- Exactly one active price list at a time.
create unique index price_lists_one_active_idx on public.price_lists (status) where status = 'active';

create or replace function public.guard_price_list()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only draft price lists can be deleted' using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'New price lists must start as draft' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.status = 'draft' and new.status = 'draft' then
    return new;
  end if;
  if not ((old.status = 'draft' and new.status = 'active')
          or (old.status = 'active' and new.status = 'archived')) then
    raise exception 'Price list status cannot change from % to %', old.status, new.status using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'published_at', 'published_by', 'updated_at'])
     is distinct from (to_jsonb(old) - array['status', 'published_at', 'published_by', 'updated_at']) then
    raise exception 'Published price lists are read-only' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger price_lists_a_guard
  before insert or update or delete on public.price_lists
  for each row execute function public.guard_price_list();

create trigger price_lists_set_updated_at
  before update on public.price_lists
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- price_list_vehicle_rates (D18: rate per km and minimum price belong to the price list version)
-- ---------------------------------------------------------------------------
create table public.price_list_vehicle_rates (
  price_list_id     uuid not null references public.price_lists (id) on delete cascade,
  vehicle_type_id   uuid not null references public.vehicle_types (id),
  rate_per_km_cents integer not null check (rate_per_km_cents >= 0),
  min_price_cents   integer not null check (min_price_cents >= 0),
  primary key (price_list_id, vehicle_type_id)
);

create index price_list_vehicle_rates_vehicle_idx on public.price_list_vehicle_rates (vehicle_type_id);

-- ---------------------------------------------------------------------------
-- price_rules (surcharges, services, storage, carrier shares)
-- ---------------------------------------------------------------------------
create table public.price_rules (
  price_list_id uuid not null references public.price_lists (id) on delete cascade,
  code          public.price_rule_code not null,
  kind          public.price_rule_kind not null,
  amount_cents  integer check (amount_cents >= 0),                  -- fixed / per_unit
  percent_bp    integer check (percent_bp between 0 and 100000),    -- percent (1 bp = 0.01 %)
  is_enabled    boolean not null default true,
  primary key (price_list_id, code),
  -- exactly one of amount_cents / percent_bp, matching kind
  check (
    (kind = 'percent' and percent_bp is not null and amount_cents is null)
    or (kind <> 'percent' and amount_cents is not null and percent_bp is null)
  ),
  -- allowed kinds per rule code
  check (
    case code
      when 'surcharge_urgent'          then kind in ('fixed', 'percent')
      when 'surcharge_weekend_holiday' then kind in ('fixed', 'percent')
      when 'carrier_share_transport'   then kind in ('fixed', 'percent')
      when 'carrier_share_porters'     then kind in ('fixed', 'percent')
      when 'carrier_share_packing'     then kind in ('fixed', 'percent')
      when 'packing_flat'              then kind = 'fixed'
      when 'transshipment_flat'        then kind = 'fixed'
      else kind = 'per_unit'
    end
  ),
  -- a carrier share cannot exceed 100 %
  check (code::text not like 'carrier_share_%' or percent_bp is null or percent_bp <= 10000)
);

-- Rates and rules can only change while their price list is a draft (for everyone).
-- A missing parent row means a cascade delete of a draft, which is allowed.
create or replace function public.guard_price_list_child()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and exists (
    select 1 from public.price_lists pl where pl.id = old.price_list_id and pl.status <> 'draft'
  ) then
    raise exception 'Published price lists are read-only' using errcode = '42501';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and exists (
    select 1 from public.price_lists pl where pl.id = new.price_list_id and pl.status <> 'draft'
  ) then
    raise exception 'Published price lists are read-only' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger price_list_vehicle_rates_guard
  before insert or update or delete on public.price_list_vehicle_rates
  for each row execute function public.guard_price_list_child();

create trigger price_rules_guard
  before insert or update or delete on public.price_rules
  for each row execute function public.guard_price_list_child();

-- ---------------------------------------------------------------------------
-- clone_price_list / publish_price_list (admin only)
-- ---------------------------------------------------------------------------
create or replace function public.clone_price_list(p_source_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can create price lists' using errcode = '42501';
  end if;

  -- Serialise version numbering.
  lock table public.price_lists in share row exclusive mode;

  insert into public.price_lists (version, vat_rate_bp, urgent_lead_hours, storage_short_term_max_days, storage_billing_unit)
  select (select coalesce(max(version), 0) + 1 from public.price_lists),
         src.vat_rate_bp, src.urgent_lead_hours, src.storage_short_term_max_days, src.storage_billing_unit
  from public.price_lists src
  where src.id = p_source_id
  returning id into v_id;

  if v_id is null then
    raise exception 'Price list % not found', p_source_id using errcode = 'P0002';
  end if;

  insert into public.price_list_vehicle_rates (price_list_id, vehicle_type_id, rate_per_km_cents, min_price_cents)
  select v_id, r.vehicle_type_id, r.rate_per_km_cents, r.min_price_cents
  from public.price_list_vehicle_rates r
  where r.price_list_id = p_source_id;

  insert into public.price_rules (price_list_id, code, kind, amount_cents, percent_bp, is_enabled)
  select v_id, r.code, r.kind, r.amount_cents, r.percent_bp, r.is_enabled
  from public.price_rules r
  where r.price_list_id = p_source_id;

  return v_id;
end;
$$;

create or replace function public.publish_price_list(p_price_list_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.price_list_status;
  v_missing_vehicles integer;
  v_missing_rules integer;
begin
  if not public.is_admin() then
    raise exception 'Only admins can publish price lists' using errcode = '42501';
  end if;

  select status into v_status from public.price_lists where id = p_price_list_id for update;
  if not found then
    raise exception 'Price list % not found', p_price_list_id using errcode = 'P0002';
  end if;
  if v_status <> 'draft' then
    raise exception 'Only draft price lists can be published' using errcode = '22023';
  end if;

  select count(*) into v_missing_vehicles
  from public.vehicle_types vt
  where vt.is_active
    and not exists (
      select 1 from public.price_list_vehicle_rates r
      where r.price_list_id = p_price_list_id and r.vehicle_type_id = vt.id
    );
  if v_missing_vehicles > 0 then
    raise exception 'Price list is missing rates for % active vehicle type(s)', v_missing_vehicles using errcode = '23514';
  end if;

  select count(*) into v_missing_rules
  from unnest(enum_range(null::public.price_rule_code)) as c(code)
  where not exists (
    select 1 from public.price_rules r where r.price_list_id = p_price_list_id and r.code = c.code
  );
  if v_missing_rules > 0 then
    raise exception 'Price list is missing % pricing rule(s)', v_missing_rules using errcode = '23514';
  end if;

  update public.price_lists set status = 'archived' where status = 'active';
  update public.price_lists
     set status = 'active', published_at = now(), published_by = auth.uid()
   where id = p_price_list_id;
end;
$$;

revoke execute on function public.clone_price_list(uuid) from public, anon;
revoke execute on function public.publish_price_list(uuid) from public, anon;
grant execute on function public.clone_price_list(uuid) to authenticated;
grant execute on function public.publish_price_list(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Initial price list (version 1). PLACEHOLDER values (D60) — the admin sets the real ones.
-- Inserted as draft, then activated, so the guards apply to the seed as well.
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
begin
  insert into public.price_lists (version, notes)
  values (1, 'Listino iniziale (valori segnaposto)')
  returning id into v_id;

  insert into public.price_list_vehicle_rates (price_list_id, vehicle_type_id, rate_per_km_cents, min_price_cents)
  select v_id, vt.id, x.rate, x.min_price
  from (values
    ('car',              90,  3500),
    ('van_small',       110,  4500),
    ('van_medium',      140,  6000),
    ('van_large',       170,  8000),
    ('truck_tail_lift', 220, 12000)
  ) as x(code, rate, min_price)
  join public.vehicle_types vt on vt.code = x.code;

  insert into public.price_rules (price_list_id, code, kind, amount_cents, percent_bp) values
    (v_id, 'surcharge_urgent',            'percent',  null, 3000),
    (v_id, 'surcharge_weekend_holiday',   'percent',  null, 2000),
    (v_id, 'surcharge_floor_no_elevator', 'per_unit', 1000, null),
    (v_id, 'porter_hour',                 'per_unit', 3000, null),
    (v_id, 'packing_flat',                'fixed',    1500, null),
    (v_id, 'packing_per_item',            'per_unit',  500, null),
    (v_id, 'storage_day',                 'per_unit',  800, null),
    (v_id, 'storage_pallet_day',          'per_unit',  300, null),
    (v_id, 'storage_day_long',            'per_unit',  500, null),
    (v_id, 'storage_pallet_day_long',     'per_unit',  200, null),
    (v_id, 'transshipment_flat',          'fixed',    2500, null),
    (v_id, 'carrier_share_transport',     'percent',  null, 7000),
    (v_id, 'carrier_share_porters',       'percent',  null, 8000),
    (v_id, 'carrier_share_packing',       'percent',  null, 6000);

  update public.price_lists set status = 'active', published_at = now() where id = v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (admin-only tables; RLS narrows to admin)
-- ---------------------------------------------------------------------------
revoke all on public.price_lists, public.price_list_vehicle_rates, public.price_rules from anon, authenticated;

grant select, delete on public.price_lists to authenticated;
grant update (vat_rate_bp, urgent_lead_hours, storage_short_term_max_days, storage_billing_unit, notes)
  on public.price_lists to authenticated;

grant select, insert, delete on public.price_list_vehicle_rates to authenticated;
grant update (rate_per_km_cents, min_price_cents) on public.price_list_vehicle_rates to authenticated;

grant select, insert, delete on public.price_rules to authenticated;
grant update (kind, amount_cents, percent_bp, is_enabled) on public.price_rules to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security: admin only (D59)
-- ---------------------------------------------------------------------------
alter table public.price_lists enable row level security;
alter table public.price_list_vehicle_rates enable row level security;
alter table public.price_rules enable row level security;

create policy price_lists_select_admin on public.price_lists
  for select to authenticated using ((select public.is_admin()));
create policy price_lists_update_admin on public.price_lists
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy price_lists_delete_admin on public.price_lists
  for delete to authenticated using ((select public.is_admin()));

create policy price_list_vehicle_rates_select_admin on public.price_list_vehicle_rates
  for select to authenticated using ((select public.is_admin()));
create policy price_list_vehicle_rates_insert_admin on public.price_list_vehicle_rates
  for insert to authenticated with check ((select public.is_admin()));
create policy price_list_vehicle_rates_update_admin on public.price_list_vehicle_rates
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy price_list_vehicle_rates_delete_admin on public.price_list_vehicle_rates
  for delete to authenticated using ((select public.is_admin()));

create policy price_rules_select_admin on public.price_rules
  for select to authenticated using ((select public.is_admin()));
create policy price_rules_insert_admin on public.price_rules
  for insert to authenticated with check ((select public.is_admin()));
create policy price_rules_update_admin on public.price_rules
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy price_rules_delete_admin on public.price_rules
  for delete to authenticated using ((select public.is_admin()));
