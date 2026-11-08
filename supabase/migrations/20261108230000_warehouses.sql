-- Stage 2b / migration 1: warehouses (D9, D72)
-- Multi-warehouse model; in the MVP at most one active warehouse (partial unique index).
-- Admin only. The booking wizard gets the warehouse address from the server (service role).
-- See docs/db-schema.md section 3.6.

create table public.warehouses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 200),
  address     text not null check (length(trim(address)) between 1 and 500), -- formatted address from Google
  street      text,
  city        text not null,
  postal_code text,
  province    char(2) not null check (province ~ '^[A-Z]{2}$'),                -- sigla; must be an active service-area province (D72, checked by the server)
  place_id    text,
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  is_active   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- MVP: one active warehouse (D72). Drop this index when more warehouses go live.
create unique index warehouses_one_active_idx on public.warehouses (is_active) where is_active;

create trigger warehouses_set_updated_at
  before update on public.warehouses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on public.warehouses from anon, authenticated;
grant select, delete on public.warehouses to authenticated;
grant insert (name, address, street, city, postal_code, province, place_id, lat, lng, is_active) on public.warehouses to authenticated;
grant update (name, address, street, city, postal_code, province, place_id, lat, lng, is_active) on public.warehouses to authenticated;

alter table public.warehouses enable row level security;

create policy warehouses_select_admin on public.warehouses
  for select to authenticated using ((select public.is_admin()));
create policy warehouses_insert_admin on public.warehouses
  for insert to authenticated with check ((select public.is_admin()));
create policy warehouses_update_admin on public.warehouses
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
-- Deleting a warehouse used by an order fails on the foreign key (orders / order_legs).
create policy warehouses_delete_admin on public.warehouses
  for delete to authenticated using ((select public.is_admin()));
