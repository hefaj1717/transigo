-- Stage 1 / migration 3: global settings (single row) and audit log
-- See docs/db-schema.md sections 3.2, 3.7 and decisions D4, D17, D33.
-- More settings columns arrive with later stages (e.g. max_route_distance_m in Stage 2).

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------
create table public.settings (
  id                       boolean primary key default true check (id), -- enforces a single row
  payout_window_hours      integer not null default 24 check (payout_window_hours >= 0),            -- D4
  gps_interval_s           integer not null default 15 check (gps_interval_s > 0),                  -- D17
  unassigned_alert_hours   integer not null default 4 check (unassigned_alert_hours > 0),
  free_cancellation_hours  integer not null default 24 check (free_cancellation_hours >= 0),        -- D33
  late_cancellation_fee_bp integer not null default 5000                                             -- D33, 5000 bp = 50 %
                             check (late_cancellation_fee_bp between 0 and 10000),
  company_name             text,
  company_vat_number       text,
  company_fiscal_code      text,
  company_street           text,
  company_city             text,
  company_postal_code      text,
  company_province         text,
  company_pec              text,
  company_sdi_code         text,
  company_email            text,
  company_phone            text,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references public.profiles (id) on delete set null
);

create or replace function public.set_settings_audit_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid(); -- null when changed by the server / SQL Editor
  return new;
end;
$$;

create trigger settings_set_audit_fields
  before update on public.settings
  for each row execute function public.set_settings_audit_fields();

insert into public.settings (id) values (true);

-- ---------------------------------------------------------------------------
-- audit_log (written by the server only, never edited)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null,          -- e.g. 'carrier.activate', 'payout.hold'
  entity_type text not null,
  entity_id   uuid,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index audit_log_entity_idx on public.audit_log (entity_type, entity_id, created_at);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.settings, public.audit_log from anon, authenticated;

grant select on public.settings to authenticated;
grant update (payout_window_hours, gps_interval_s, unassigned_alert_hours,
              free_cancellation_hours, late_cancellation_fee_bp,
              company_name, company_vat_number, company_fiscal_code, company_street, company_city,
              company_postal_code, company_province, company_pec, company_sdi_code,
              company_email, company_phone)
  on public.settings to authenticated;

grant select on public.audit_log to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security: admin only
-- ---------------------------------------------------------------------------
alter table public.settings enable row level security;
alter table public.audit_log enable row level security;

create policy settings_select_admin on public.settings
  for select to authenticated
  using ((select public.is_admin()));

create policy settings_update_admin on public.settings
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using ((select public.is_admin()));
