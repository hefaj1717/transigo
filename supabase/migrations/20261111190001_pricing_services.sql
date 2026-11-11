-- Three equal services (D151, D154, D157; plan docs/plany/tre-servizi.md, section 3), versioned with the
-- price list (D60):
--   * Porters-only service: persons × max(hours, porters_min_hours) × porter_hour + floors without elevator
--     × porters_floor_no_elevator; at least porters_min_persons persons (D157: 2).
--   * Storage boxes for private customers (D154): price = full 30-day months × month_cents + remaining days
--     × day_cents (computed by the app, src/lib/pricing/storage-service.ts).
--   * Published lists are not touched (immutable, D60): they keep working, the new services just stay
--     unavailable until a new version (clone → publish) is published.

alter table public.price_lists
  add column porters_min_hours integer not null default 2 check (porters_min_hours between 1 and 12),
  add column porters_min_persons integer not null default 2 check (porters_min_persons between 2 and 4); -- D157, D54

grant update (porters_min_hours, porters_min_persons) on public.price_lists to authenticated;

create table public.price_list_storage_boxes (
  price_list_id uuid not null references public.price_lists (id) on delete cascade,
  code          text not null check (code ~ '^[a-z0-9_]{1,20}$'),            -- stable key, not editable
  label_it      text not null check (char_length(btrim(label_it)) between 1 and 60),
  volume_m3     numeric(5, 2) not null check (volume_m3 > 0 and volume_m3 <= 100),
  day_cents     integer not null check (day_cents > 0),
  month_cents   integer not null check (month_cents > 0),
  sort_order    integer not null default 0 check (sort_order between 0 and 999),
  is_enabled    boolean not null default true,
  primary key (price_list_id, code)
);

create trigger price_list_storage_boxes_guard
  before insert or update or delete on public.price_list_storage_boxes
  for each row execute function public.guard_price_list_child();

revoke all on public.price_list_storage_boxes from anon, authenticated;
grant select, insert, delete on public.price_list_storage_boxes to authenticated;
grant update (label_it, volume_m3, day_cents, month_cents, sort_order, is_enabled)
  on public.price_list_storage_boxes to authenticated;

alter table public.price_list_storage_boxes enable row level security;

create policy price_list_storage_boxes_select_admin on public.price_list_storage_boxes
  for select to authenticated using ((select public.is_admin()));
create policy price_list_storage_boxes_insert_admin on public.price_list_storage_boxes
  for insert to authenticated with check ((select public.is_admin()));
create policy price_list_storage_boxes_update_admin on public.price_list_storage_boxes
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy price_list_storage_boxes_delete_admin on public.price_list_storage_boxes
  for delete to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Placeholder defaults (D154, D157) for a draft that lacks them. Internal helper, not callable by API users.
-- Boxes are added only when the list has none (a box removed on purpose does not come back).
-- ---------------------------------------------------------------------------
create or replace function public.fill_service_defaults(p_price_list_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.price_rules (price_list_id, code, kind, amount_cents, percent_bp)
  values (p_price_list_id, 'porters_floor_no_elevator', 'per_unit', 1000, null)
  on conflict (price_list_id, code) do nothing;

  if not exists (select 1 from public.price_list_storage_boxes b where b.price_list_id = p_price_list_id) then
    insert into public.price_list_storage_boxes (price_list_id, code, label_it, volume_m3, day_cents, month_cents, sort_order)
    values
      (p_price_list_id, 's', 'Box S',  3, 300,  6000, 1),
      (p_price_list_id, 'm', 'Box M',  6, 500, 10000, 2),
      (p_price_list_id, 'l', 'Box L', 10, 800, 15000, 3);
  end if;
end;
$$;

revoke execute on function public.fill_service_defaults(uuid) from public, anon, authenticated;

-- Existing drafts get the defaults (drafts are editable); published lists stay as they are.
select public.fill_service_defaults(id) from public.price_lists where status = 'draft';

-- ---------------------------------------------------------------------------
-- clone_price_list: also copies the porters minimums and storage boxes; fills defaults the source lacks.
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

  insert into public.price_lists (version, vat_rate_bp, urgent_lead_hours, storage_short_term_max_days, storage_billing_unit,
                                  porter_overtime_grace_minutes, porters_min_hours, porters_min_persons)
  select (select coalesce(max(version), 0) + 1 from public.price_lists),
         src.vat_rate_bp, src.urgent_lead_hours, src.storage_short_term_max_days, src.storage_billing_unit,
         src.porter_overtime_grace_minutes, src.porters_min_hours, src.porters_min_persons
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

  insert into public.price_list_storage_boxes (price_list_id, code, label_it, volume_m3, day_cents, month_cents, sort_order, is_enabled)
  select v_id, b.code, b.label_it, b.volume_m3, b.day_cents, b.month_cents, b.sort_order, b.is_enabled
  from public.price_list_storage_boxes b
  where b.price_list_id = p_source_id;

  perform public.fill_porter_defaults(v_id);
  perform public.fill_service_defaults(v_id);

  return v_id;
end;
$$;
