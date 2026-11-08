-- Stage 1 / migration 1: accounts and roles
-- Tables: profiles, customers, carriers
-- See docs/db-schema.md sections 1, 3.1, 6.
--
-- Security model:
--   * Rows in profiles are created only by the auth.users trigger; customers/carriers only by the server (service role).
--   * Column-level grants decide which columns authenticated users may change; everything else
--     (role, statuses, Stripe fields, verification timestamps) is server-only.
--   * protect_server_columns() is a second line of defense against changes to server-only columns.
--   * A blocked profile (is_blocked) makes auth_role() return null, so no role-based policy matches.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.user_role as enum ('cliente', 'padroncino', 'admin');
create type public.customer_type as enum ('private', 'business');
create type public.carrier_status as enum ('pending_review', 'active', 'rejected', 'suspended');

-- ---------------------------------------------------------------------------
-- Generic trigger functions
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Raises if an API user (anon/authenticated) changes any of the columns passed as trigger arguments.
-- The server (service_role) and SQL Editor (postgres) are allowed.
create or replace function public.protect_server_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  col text;
begin
  if current_user in ('anon', 'authenticated') then
    foreach col in array tg_argv loop
      if (to_jsonb(new) -> col) is distinct from (to_jsonb(old) -> col) then
        raise exception 'Column %.% can only be changed by the server', tg_table_name, col
          using errcode = '42501';
      end if;
    end loop;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  role                public.user_role not null default 'cliente',
  first_name          text,
  last_name           text,
  email               text not null unique,
  phone               text,
  is_blocked          boolean not null default false,
  privacy_accepted_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index profiles_role_idx on public.profiles (role);

create trigger profiles_a_protect_columns
  before update on public.profiles
  for each row execute function public.protect_server_columns('id', 'role', 'email', 'is_blocked', 'privacy_accepted_at', 'created_at');

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS helper functions (SECURITY DEFINER: read profiles without recursing into RLS)
-- ---------------------------------------------------------------------------

-- Role of the signed-in user; null when not signed in or when the account is blocked.
create or replace function public.auth_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
    and not p.is_blocked;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.auth_role() = 'admin', false);
$$;

revoke execute on function public.auth_role() from public, anon;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.auth_role() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- auth.users triggers
-- ---------------------------------------------------------------------------

-- Creates the profile. The role comes from sign-up metadata but only 'padroncino' is honoured;
-- anything else (including 'admin') becomes 'cliente'. Admin is granted manually in SQL only.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_role text := new.raw_user_meta_data ->> 'role';
begin
  insert into public.profiles (id, role, email, first_name, last_name, phone)
  values (
    new.id,
    case when requested_role = 'padroncino' then 'padroncino'::public.user_role
         else 'cliente'::public.user_role end,
    new.email,
    nullif(trim(new.raw_user_meta_data ->> 'first_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'last_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.sync_profile_email();

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.sync_profile_email() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
create table public.customers (
  profile_id          uuid primary key references public.profiles (id) on delete cascade,
  customer_type       public.customer_type not null,
  company_name        text,
  vat_number          text,
  fiscal_code         text,
  sdi_code            text,
  pec                 text,
  billing_street      text,
  billing_city        text,
  billing_postal_code text,
  billing_province    text,
  billing_country     char(2) not null default 'IT',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint customers_business_fields_check
    check (customer_type <> 'business' or (company_name is not null and vat_number is not null)),
  constraint customers_private_fields_check
    check (customer_type <> 'private' or fiscal_code is not null)
);

create trigger customers_a_protect_columns
  before update on public.customers
  for each row execute function public.protect_server_columns('profile_id', 'customer_type', 'created_at');

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- carriers
-- ---------------------------------------------------------------------------
create table public.carriers (
  profile_id               uuid primary key references public.profiles (id) on delete cascade,
  status                   public.carrier_status not null default 'pending_review',
  status_reason            text,
  activated_at             timestamptz,
  activated_by             uuid references public.profiles (id) on delete set null,
  company_name             text not null,
  vat_number               text not null unique,
  fiscal_code              text,
  pec                      text,
  sdi_code                 text,
  hq_street                text,
  hq_city                  text,
  hq_postal_code           text,
  hq_province              text,
  phone_verified_at        timestamptz,
  stripe_account_id        text unique,
  stripe_details_submitted boolean not null default false,
  stripe_payouts_enabled   boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index carriers_status_idx on public.carriers (status);

create trigger carriers_a_protect_columns
  before update on public.carriers
  for each row execute function public.protect_server_columns(
    'profile_id', 'status', 'status_reason', 'activated_at', 'activated_by', 'phone_verified_at',
    'stripe_account_id', 'stripe_details_submitted', 'stripe_payouts_enabled', 'created_at');

create trigger carriers_set_updated_at
  before update on public.carriers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Privileges (explicit; RLS still applies on top)
-- ---------------------------------------------------------------------------
revoke all on public.profiles, public.customers, public.carriers from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (first_name, last_name, phone) on public.profiles to authenticated;

grant select on public.customers to authenticated;
grant update (company_name, vat_number, fiscal_code, sdi_code, pec,
              billing_street, billing_city, billing_postal_code, billing_province, billing_country)
  on public.customers to authenticated;

grant select on public.carriers to authenticated;
grant update (company_name, vat_number, fiscal_code, pec, sdi_code,
              hq_street, hq_city, hq_postal_code, hq_province)
  on public.carriers to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.customers enable row level security;
alter table public.carriers enable row level security;

-- profiles: own row (not blocked) or admin
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) and (select public.auth_role()) is not null);

create policy profiles_select_admin on public.profiles
  for select to authenticated
  using ((select public.is_admin()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) and (select public.auth_role()) is not null)
  with check (id = (select auth.uid()));

-- customers: the customer themself or admin
create policy customers_select_own on public.customers
  for select to authenticated
  using (profile_id = (select auth.uid()) and (select public.auth_role()) = 'cliente');

create policy customers_select_admin on public.customers
  for select to authenticated
  using ((select public.is_admin()));

create policy customers_update_own on public.customers
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.auth_role()) = 'cliente')
  with check (profile_id = (select auth.uid()));

-- carriers: the carrier themself or admin
create policy carriers_select_own on public.carriers
  for select to authenticated
  using (profile_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino');

create policy carriers_select_admin on public.carriers
  for select to authenticated
  using ((select public.is_admin()));

create policy carriers_update_own on public.carriers
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.auth_role()) = 'padroncino')
  with check (profile_id = (select auth.uid()));
