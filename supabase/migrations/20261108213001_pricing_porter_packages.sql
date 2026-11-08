-- Porter packages (D67) and overtime (D68), versioned with the price list (D60).
--   * The customer picks a load size; each package has a number of porters and the hours included.
--     Package price = persons × included hours × porter_hour. The customer may add porters, not hours.
--   * Overtime: per person, per started hour above the included time, charged only when the actual
--     work exceeds included time + porter_overtime_grace_minutes (rule porter_overtime_hour).
--   * Published lists are not touched (immutable, D60): they keep working without packages, porters
--     just become unavailable until a new version (clone → publish) is published.

create type public.porter_package_code as enum ('parcels', 'monolocale', 'bilocale', 'trilocale_plus');

alter table public.price_lists
  add column porter_overtime_grace_minutes integer not null default 15
    check (porter_overtime_grace_minutes between 0 and 120);

grant update (porter_overtime_grace_minutes) on public.price_lists to authenticated;

create table public.price_list_porter_packages (
  price_list_id  uuid not null references public.price_lists (id) on delete cascade,
  code           public.porter_package_code not null,
  porters_count  integer not null check (porters_count between 1 and 4),   -- D54: 1–4 porters
  included_hours integer not null check (included_hours between 1 and 8),
  is_enabled     boolean not null default true,
  primary key (price_list_id, code)
);

create trigger price_list_porter_packages_guard
  before insert or update or delete on public.price_list_porter_packages
  for each row execute function public.guard_price_list_child();

revoke all on public.price_list_porter_packages from anon, authenticated;
grant select, insert, delete on public.price_list_porter_packages to authenticated;
grant update (porters_count, included_hours, is_enabled) on public.price_list_porter_packages to authenticated;

alter table public.price_list_porter_packages enable row level security;

create policy price_list_porter_packages_select_admin on public.price_list_porter_packages
  for select to authenticated using ((select public.is_admin()));
create policy price_list_porter_packages_insert_admin on public.price_list_porter_packages
  for insert to authenticated with check ((select public.is_admin()));
create policy price_list_porter_packages_update_admin on public.price_list_porter_packages
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy price_list_porter_packages_delete_admin on public.price_list_porter_packages
  for delete to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Placeholder defaults (D67, D68) for a draft that lacks them. Internal helper, not callable by API users.
-- ---------------------------------------------------------------------------
create or replace function public.fill_porter_defaults(p_price_list_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.price_list_porter_packages (price_list_id, code, porters_count, included_hours)
  values
    (p_price_list_id, 'parcels',        1, 1),
    (p_price_list_id, 'monolocale',     2, 2),
    (p_price_list_id, 'bilocale',       2, 3),
    (p_price_list_id, 'trilocale_plus', 3, 4)
  on conflict (price_list_id, code) do nothing;

  insert into public.price_rules (price_list_id, code, kind, amount_cents, percent_bp)
  values (p_price_list_id, 'porter_overtime_hour', 'per_unit', 3500, null)
  on conflict (price_list_id, code) do nothing;
end;
$$;

revoke execute on function public.fill_porter_defaults(uuid) from public, anon, authenticated;

-- Existing drafts get the defaults (drafts are editable); published lists stay as they are.
select public.fill_porter_defaults(id) from public.price_lists where status = 'draft';

-- ---------------------------------------------------------------------------
-- clone_price_list: also copies the grace minutes and packages; fills defaults the source lacks.
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

  insert into public.price_lists (version, vat_rate_bp, urgent_lead_hours, storage_short_term_max_days, storage_billing_unit, porter_overtime_grace_minutes)
  select (select coalesce(max(version), 0) + 1 from public.price_lists),
         src.vat_rate_bp, src.urgent_lead_hours, src.storage_short_term_max_days, src.storage_billing_unit, src.porter_overtime_grace_minutes
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

  insert into public.price_list_porter_packages (price_list_id, code, porters_count, included_hours, is_enabled)
  select v_id, p.code, p.porters_count, p.included_hours, p.is_enabled
  from public.price_list_porter_packages p
  where p.price_list_id = p_source_id;

  perform public.fill_porter_defaults(v_id);

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- publish_price_list: additionally requires all four porter packages (they may be disabled).
-- The rule check already covers porter_overtime_hour (it checks every enum value).
-- ---------------------------------------------------------------------------
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
  v_missing_packages integer;
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

  select count(*) into v_missing_packages
  from unnest(enum_range(null::public.porter_package_code)) as c(code)
  where not exists (
    select 1 from public.price_list_porter_packages p where p.price_list_id = p_price_list_id and p.code = c.code
  );
  if v_missing_packages > 0 then
    raise exception 'Price list is missing % porter package(s)', v_missing_packages using errcode = '23514';
  end if;

  update public.price_lists set status = 'archived' where status = 'active';
  update public.price_lists
     set status = 'active', published_at = now(), published_by = auth.uid()
   where id = p_price_list_id;
end;
$$;
