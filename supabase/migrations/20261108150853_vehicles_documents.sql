-- Stage 1 / migration 2: vehicle types, carrier vehicles, carrier documents, documents bucket
-- See docs/db-schema.md sections 3.1, 3.2, 5, 6 and decisions D7, D22.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.carrier_document_type as enum (
  'transport_license', 'insurance_rca', 'goods_insurance',
  'vehicle_registration', 'identity_document', 'driving_license'
);
create type public.review_status as enum ('pending', 'approved', 'rejected');

-- ---------------------------------------------------------------------------
-- vehicle_types (prices per km / minimum price live in the price list, Stage 2 — D18)
-- ---------------------------------------------------------------------------
create table public.vehicle_types (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name_it          text not null,
  payload_kg       integer check (payload_kg > 0),
  cargo_length_cm  integer check (cargo_length_cm > 0),
  cargo_width_cm   integer check (cargo_width_cm > 0),
  cargo_height_cm  integer check (cargo_height_cm > 0),
  cargo_volume_dm3 integer check (cargo_volume_dm3 > 0),
  -- 1 = smallest. A carrier sees jobs for types with size_rank <= their largest vehicle (D22).
  size_rank        smallint not null unique check (size_rank > 0),
  is_active        boolean not null default true,
  sort_order       smallint not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger vehicle_types_set_updated_at
  before update on public.vehicle_types
  for each row execute function public.set_updated_at();

-- Starting types (D7). Payload and dimensions are left for the admin to fill in.
insert into public.vehicle_types (code, name_it, cargo_volume_dm3, size_rank, sort_order) values
  ('car',             'Auto / station wagon',             null, 1, 10),
  ('van_small',       'Furgone piccolo',                  3000, 2, 20),
  ('van_medium',      'Furgone medio',                    9000, 3, 30),
  ('van_large',       'Furgone grande 3,5 t',            20000, 4, 40),
  ('truck_tail_lift', 'Camion con sponda idraulica',      null, 5, 50);

-- ---------------------------------------------------------------------------
-- carrier_vehicles
-- ---------------------------------------------------------------------------
create table public.carrier_vehicles (
  id              uuid primary key default gen_random_uuid(),
  carrier_id      uuid not null references public.carriers (profile_id) on delete cascade,
  vehicle_type_id uuid not null references public.vehicle_types (id),
  plate           text not null unique,
  payload_kg      integer check (payload_kg > 0),
  cargo_length_cm integer check (cargo_length_cm > 0),
  cargo_width_cm  integer check (cargo_width_cm > 0),
  cargo_height_cm integer check (cargo_height_cm > 0),
  is_active       boolean not null default true,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index carrier_vehicles_carrier_idx on public.carrier_vehicles (carrier_id);
create index carrier_vehicles_type_idx on public.carrier_vehicles (vehicle_type_id);

-- Fires first (name order): API users cannot touch server-only columns.
create trigger carrier_vehicles_a_protect_columns
  before update on public.carrier_vehicles
  for each row execute function public.protect_server_columns('id', 'carrier_id', 'approved_at', 'created_at');

-- Fires second: a carrier changing type or plate loses the admin approval.
create or replace function public.reset_vehicle_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and (new.vehicle_type_id is distinct from old.vehicle_type_id or new.plate is distinct from old.plate) then
    new.approved_at = null;
  end if;
  return new;
end;
$$;

create trigger carrier_vehicles_b_reset_approval
  before update on public.carrier_vehicles
  for each row execute function public.reset_vehicle_approval();

create trigger carrier_vehicles_set_updated_at
  before update on public.carrier_vehicles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- carrier_documents (files in the private carrier-documents bucket)
-- ---------------------------------------------------------------------------
create table public.carrier_documents (
  id               uuid primary key default gen_random_uuid(),
  carrier_id       uuid not null references public.carriers (profile_id) on delete cascade,
  vehicle_id       uuid references public.carrier_vehicles (id) on delete set null,
  doc_type         public.carrier_document_type not null,
  storage_path     text not null,
  expires_at       date,
  review_status    public.review_status not null default 'pending',
  reviewed_by      uuid references public.profiles (id) on delete set null,
  reviewed_at      timestamptz,
  rejection_reason text,
  created_at       timestamptz not null default now()
);

create index carrier_documents_carrier_type_idx on public.carrier_documents (carrier_id, doc_type);
create index carrier_documents_expires_idx on public.carrier_documents (expires_at);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.vehicle_types, public.carrier_vehicles, public.carrier_documents from anon, authenticated;

-- vehicle_types: public read (booking wizard works without login); admin writes (RLS limits to admin).
grant select on public.vehicle_types to anon, authenticated;
grant insert, update on public.vehicle_types to authenticated;

-- carrier_vehicles: carriers manage their own, except approval; no delete (deactivate instead).
grant select on public.carrier_vehicles to authenticated;
grant insert (carrier_id, vehicle_type_id, plate, payload_kg, cargo_length_cm, cargo_width_cm, cargo_height_cm, is_active)
  on public.carrier_vehicles to authenticated;
grant update (vehicle_type_id, plate, payload_kg, cargo_length_cm, cargo_width_cm, cargo_height_cm, is_active)
  on public.carrier_vehicles to authenticated;

-- carrier_documents: carriers upload (insert) their own; review fields are server-only; no update/delete.
grant select on public.carrier_documents to authenticated;
grant insert (carrier_id, vehicle_id, doc_type, storage_path, expires_at)
  on public.carrier_documents to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.vehicle_types enable row level security;
alter table public.carrier_vehicles enable row level security;
alter table public.carrier_documents enable row level security;

-- vehicle_types
create policy vehicle_types_select_active on public.vehicle_types
  for select to anon, authenticated
  using (is_active);

create policy vehicle_types_select_admin on public.vehicle_types
  for select to authenticated
  using ((select public.is_admin()));

create policy vehicle_types_insert_admin on public.vehicle_types
  for insert to authenticated
  with check ((select public.is_admin()));

create policy vehicle_types_update_admin on public.vehicle_types
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- carrier_vehicles
create policy carrier_vehicles_select_own on public.carrier_vehicles
  for select to authenticated
  using (carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino');

create policy carrier_vehicles_select_admin on public.carrier_vehicles
  for select to authenticated
  using ((select public.is_admin()));

create policy carrier_vehicles_insert_own on public.carrier_vehicles
  for insert to authenticated
  with check (carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino');

create policy carrier_vehicles_update_own on public.carrier_vehicles
  for update to authenticated
  using (carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino')
  with check (carrier_id = (select auth.uid()));

-- carrier_documents
create policy carrier_documents_select_own on public.carrier_documents
  for select to authenticated
  using (carrier_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino');

create policy carrier_documents_select_admin on public.carrier_documents
  for select to authenticated
  using ((select public.is_admin()));

create policy carrier_documents_insert_own on public.carrier_documents
  for insert to authenticated
  with check (
    carrier_id = (select auth.uid())
    and (select public.auth_role()) = 'padroncino'
    -- file must live in the carrier's own folder: {carrier_id}/...
    and storage_path like (select auth.uid())::text || '/%'
    -- a linked vehicle must belong to the same carrier
    and (
      vehicle_id is null
      or exists (
        select 1 from public.carrier_vehicles v
        where v.id = vehicle_id and v.carrier_id = (select auth.uid())
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Storage: private bucket for carrier documents
-- Path convention: {carrier_id}/{document_id}.{ext}. Files are immutable (no update/delete by users).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'carrier-documents', 'carrier-documents', false, 10485760, -- 10 MB
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do nothing;

create policy carrier_documents_storage_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'carrier-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.auth_role()) = 'padroncino'
  );

create policy carrier_documents_storage_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'carrier-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.auth_role()) = 'padroncino'
  );

create policy carrier_documents_storage_select_admin on storage.objects
  for select to authenticated
  using (bucket_id = 'carrier-documents' and (select public.is_admin()));
