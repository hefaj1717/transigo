-- Stage 4 / part 1: carrier onboarding and admin review (D97–D103)
--   * carrier_document_types: one configuration of document types (scope, required, expiry rule, labels);
--     mirrored in code by src/lib/carriers/document-types.ts (a test keeps both equal)
--   * carrier_documents: file metadata, path format, type-dependent rules (trigger reading the configuration)
--   * carrier_vehicles: payload required, normalised plate
--   * carriers: submitted_at, decided_at, decided_by (server-only)
--   * carrier_onboarding_missing(), submit_carrier_for_review(), decide_carrier_review()
-- See docs/spec.md D97–D103, docs/db-schema.md.

-- ---------------------------------------------------------------------------
-- carrier_document_types (D98)
-- ---------------------------------------------------------------------------
create type public.carrier_document_scope as enum ('carrier', 'vehicle');
create type public.carrier_document_expiry as enum ('none', 'required');

create table public.carrier_document_types (
  doc_type        public.carrier_document_type primary key,
  scope           public.carrier_document_scope not null,
  is_required     boolean not null,
  -- false = no longer accepted for new uploads (kept in the enum for existing rows)
  is_accepted     boolean not null,
  expiry          public.carrier_document_expiry not null,
  label_it        text not null,
  expiry_label_it text,
  sort_order      smallint not null,
  constraint carrier_document_types_expiry_label check ((expiry = 'required') = (expiry_label_it is not null)),
  constraint carrier_document_types_required_accepted check (not is_required or is_accepted)
);

-- Changed only by migrations (together with src/lib/carriers/document-types.ts).
insert into public.carrier_document_types (doc_type, scope, is_required, is_accepted, expiry, label_it, expiry_label_it, sort_order) values
  ('transport_license',    'carrier', true,  true,  'none',     'Iscrizione all''Albo degli autotrasportatori', null,                 10),
  ('driving_license',      'carrier', true,  true,  'required', 'Patente del titolare',                         'Scadenza',           20),
  ('goods_insurance',      'carrier', false, true,  'required', 'Polizza RC vettoriale',                        'Scadenza',           30),
  ('vehicle_registration', 'vehicle', true,  true,  'required', 'Libretto di circolazione',                     'Prossima revisione', 40),
  ('insurance_rca',        'vehicle', true,  true,  'required', 'Assicurazione RCA',                            'Scadenza',           50),
  ('identity_document',    'carrier', false, false, 'none',     'Documento d''identità',                        null,                 90);

revoke all on public.carrier_document_types from anon, authenticated;
grant select on public.carrier_document_types to authenticated;

alter table public.carrier_document_types enable row level security;

create policy carrier_document_types_select on public.carrier_document_types
  for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- carrier_documents: file metadata, path format, type-dependent rules
-- (staging has no rows, checked 2026-11-09 — constraints are validated directly)
-- ---------------------------------------------------------------------------
alter table public.carrier_documents
  add column file_name  text    not null check (length(file_name) between 1 and 255),
  add column mime_type  text    not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  add column size_bytes integer not null check (size_bytes between 1 and 10485760), -- 10 MB, as the bucket
  add constraint carrier_documents_storage_path_format check (
    storage_path ~ ('^' || carrier_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp|heic)$')
  ),
  add constraint carrier_documents_storage_path_unique unique (storage_path),
  add constraint carrier_documents_rejection_reason_length check (length(rejection_reason) <= 1000);

-- A CHECK cannot read another table, so the type-dependent rules (D98) are a trigger reading
-- carrier_document_types. Applies to everyone, service role included.
create or replace function public.validate_carrier_document()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cfg public.carrier_document_types%rowtype;
begin
  select * into cfg from public.carrier_document_types where doc_type = new.doc_type;
  if not found then
    raise exception 'carrier_documents: unknown document type %', new.doc_type using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and not cfg.is_accepted then
    raise exception 'carrier_documents: document type % is not accepted', new.doc_type using errcode = '23514';
  end if;
  if cfg.expiry = 'required' and new.expires_at is null then
    raise exception 'carrier_documents: % requires an expiry date', new.doc_type using errcode = '23514';
  end if;
  if cfg.expiry = 'none' and new.expires_at is not null then
    raise exception 'carrier_documents: % has no expiry date', new.doc_type using errcode = '23514';
  end if;
  if cfg.scope = 'vehicle' and new.vehicle_id is null then
    raise exception 'carrier_documents: % belongs to a vehicle', new.doc_type using errcode = '23514';
  end if;
  if cfg.scope = 'carrier' and new.vehicle_id is not null then
    raise exception 'carrier_documents: % is not a vehicle document', new.doc_type using errcode = '23514';
  end if;
  if new.vehicle_id is not null and not exists (
    select 1 from public.carrier_vehicles v where v.id = new.vehicle_id and v.carrier_id = new.carrier_id
  ) then
    raise exception 'carrier_documents: vehicle of another carrier' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger carrier_documents_validate
  before insert or update of doc_type, expires_at, vehicle_id, carrier_id on public.carrier_documents
  for each row execute function public.validate_carrier_document();

grant insert (file_name, mime_type, size_bytes) on public.carrier_documents to authenticated;

-- ---------------------------------------------------------------------------
-- carrier_vehicles: payload required, normalised plate (upper case, letters and digits only)
-- ---------------------------------------------------------------------------
alter table public.carrier_vehicles
  alter column payload_kg set not null,
  add constraint carrier_vehicles_plate_format check (plate ~ '^[A-Z0-9]{5,10}$');

-- ---------------------------------------------------------------------------
-- carriers: review timestamps (server-only)
-- ---------------------------------------------------------------------------
alter table public.carriers
  add column submitted_at timestamptz,  -- sent for review; null = registration incomplete (or rejected)
  add column decided_at   timestamptz,  -- last admin decision
  add column decided_by   uuid references public.profiles (id) on delete set null,
  add constraint carriers_status_reason_length check (length(status_reason) <= 1000);

drop trigger carriers_a_protect_columns on public.carriers;
create trigger carriers_a_protect_columns
  before update on public.carriers
  for each row execute function public.protect_server_columns(
    'profile_id', 'status', 'status_reason', 'activated_at', 'activated_by', 'phone_verified_at',
    'stripe_account_id', 'stripe_details_submitted', 'stripe_payouts_enabled', 'created_at',
    'submitted_at', 'decided_at', 'decided_by');

create index carriers_review_queue_idx on public.carriers (submitted_at) where status = 'pending_review';

-- ---------------------------------------------------------------------------
-- carrier_onboarding_missing(): what is still missing before review / approval (D99)
-- Codes: 'company', 'vehicle', 'document:<doc_type>', 'vehicle_document:<vehicle_id>:<doc_type>'.
-- A document counts when it is not rejected and (no expiry, or expires_at >= today in Europe/Rome).
-- Callable by the carrier itself (own id only), an admin, or the server.
-- ---------------------------------------------------------------------------
create or replace function public.carrier_onboarding_missing(p_carrier_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today   date := (now() at time zone 'Europe/Rome')::date;
  v_carrier public.carriers%rowtype;
  v_missing text[] := '{}';
begin
  -- Inside SECURITY DEFINER current_user is the owner, so the caller's role comes from the JWT:
  -- 'service_role' (server) or no JWT (SQL Editor) may check anyone; anon has no EXECUTE.
  if auth.role() = 'authenticated'
     and not (p_carrier_id = auth.uid() and public.auth_role() = 'padroncino')
     and not public.is_admin() then
    raise exception 'carrier_onboarding_missing: not allowed' using errcode = '42501';
  end if;

  select * into v_carrier from public.carriers where profile_id = p_carrier_id;
  if not found then
    raise exception 'carrier_onboarding_missing: carrier not found' using errcode = '22023';
  end if;

  if coalesce(trim(v_carrier.company_name), '') = '' or coalesce(trim(v_carrier.vat_number), '') = ''
     or coalesce(trim(v_carrier.fiscal_code), '') = '' or coalesce(trim(v_carrier.hq_street), '') = ''
     or coalesce(trim(v_carrier.hq_city), '') = '' or coalesce(trim(v_carrier.hq_postal_code), '') = ''
     or coalesce(trim(v_carrier.hq_province), '') = ''
     or (coalesce(trim(v_carrier.pec), '') = '' and coalesce(trim(v_carrier.sdi_code), '') = '') then
    v_missing := array_append(v_missing, 'company');
  end if;

  if not exists (select 1 from public.carrier_vehicles where carrier_id = p_carrier_id and is_active) then
    v_missing := array_append(v_missing, 'vehicle');
  end if;

  v_missing := v_missing || coalesce((
    select array_agg('document:' || t.doc_type::text order by t.sort_order)
    from public.carrier_document_types t
    where t.scope = 'carrier' and t.is_required
      and not exists (
        select 1 from public.carrier_documents d
        where d.carrier_id = p_carrier_id and d.doc_type = t.doc_type and d.review_status <> 'rejected'
          and (t.expiry = 'none' or d.expires_at >= v_today)
      )
  ), '{}');

  v_missing := v_missing || coalesce((
    select array_agg('vehicle_document:' || v.id::text || ':' || t.doc_type::text order by v.created_at, t.sort_order)
    from public.carrier_vehicles v
    cross join public.carrier_document_types t
    where v.carrier_id = p_carrier_id and v.is_active
      and t.scope = 'vehicle' and t.is_required
      and not exists (
        select 1 from public.carrier_documents d
        where d.carrier_id = p_carrier_id and d.vehicle_id = v.id and d.doc_type = t.doc_type
          and d.review_status <> 'rejected'
          and (t.expiry = 'none' or d.expires_at >= v_today)
      )
  ), '{}');

  return v_missing;
end;
$$;

revoke execute on function public.carrier_onboarding_missing(uuid) from public, anon;
grant execute on function public.carrier_onboarding_missing(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- submit_carrier_for_review(): the signed-in carrier sends its account for review (D100)
-- pending_review (not yet submitted) or rejected → pending_review + submitted_at. Already submitted → no-op.
-- ---------------------------------------------------------------------------
create or replace function public.submit_carrier_for_review()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      uuid := auth.uid();
  v_carrier public.carriers%rowtype;
  v_missing text[];
begin
  if v_id is null or public.auth_role() is distinct from 'padroncino' then
    raise exception 'submit_carrier_for_review: not allowed' using errcode = '42501';
  end if;

  select * into v_carrier from public.carriers where profile_id = v_id for update;
  if not found then
    raise exception 'submit_carrier_for_review: carrier not found' using errcode = '22023';
  end if;
  if v_carrier.status = 'pending_review' and v_carrier.submitted_at is not null then
    return v_carrier.submitted_at; -- already waiting for the admin
  end if;
  if v_carrier.status not in ('pending_review', 'rejected') then
    raise exception 'submit_carrier_for_review: account is %', v_carrier.status using errcode = '55000';
  end if;

  v_missing := public.carrier_onboarding_missing(v_id);
  if cardinality(v_missing) > 0 then
    raise exception 'submit_carrier_for_review: incomplete' using errcode = '23514', detail = array_to_string(v_missing, ',');
  end if;

  update public.carriers
     set status = 'pending_review', status_reason = null, submitted_at = now()
   where profile_id = v_id
  returning submitted_at into v_carrier.submitted_at;
  return v_carrier.submitted_at;
end;
$$;

revoke execute on function public.submit_carrier_for_review() from public, anon;
grant execute on function public.submit_carrier_for_review() to authenticated;

-- ---------------------------------------------------------------------------
-- decide_carrier_review(): admin decision (D101). Server only; p_admin_id comes from the admin's session.
-- Approve: completeness checked again; account active; documents and vehicles that existed at submission
--          are approved (anything added later stays pending).
-- Reject:  reason required; account rejected, submitted_at cleared (the carrier can fix and resubmit).
-- A second decision on the same submission raises 55000 (no second e-mail).
-- ---------------------------------------------------------------------------
create or replace function public.decide_carrier_review(p_carrier_id uuid, p_admin_id uuid, p_approve boolean, p_reason text default null)
returns public.carrier_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_carrier public.carriers%rowtype;
  v_reason  text := nullif(trim(p_reason), '');
  v_missing text[];
begin
  if p_approve is null then
    raise exception 'decide_carrier_review: decision required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin' and not is_blocked) then
    raise exception 'decide_carrier_review: not an admin' using errcode = '42501';
  end if;

  select * into v_carrier from public.carriers where profile_id = p_carrier_id for update;
  if not found then
    raise exception 'decide_carrier_review: carrier not found' using errcode = '22023';
  end if;
  if v_carrier.status <> 'pending_review' or v_carrier.submitted_at is null then
    raise exception 'decide_carrier_review: not awaiting review' using errcode = '55000';
  end if;

  if p_approve then
    v_missing := public.carrier_onboarding_missing(p_carrier_id);
    if cardinality(v_missing) > 0 then
      raise exception 'decide_carrier_review: incomplete' using errcode = '23514', detail = array_to_string(v_missing, ',');
    end if;

    update public.carrier_documents
       set review_status = 'approved', reviewed_by = p_admin_id, reviewed_at = now()
     where carrier_id = p_carrier_id and review_status = 'pending' and created_at <= v_carrier.submitted_at;

    update public.carrier_vehicles
       set approved_at = now()
     where carrier_id = p_carrier_id and is_active and approved_at is null and updated_at <= v_carrier.submitted_at;

    update public.carriers
       set status = 'active', status_reason = null, activated_at = now(), activated_by = p_admin_id,
           decided_at = now(), decided_by = p_admin_id
     where profile_id = p_carrier_id;
    return 'active';
  end if;

  if v_reason is null or length(v_reason) > 1000 then
    raise exception 'decide_carrier_review: a reason (max 1000 characters) is required' using errcode = '22023';
  end if;
  update public.carriers
     set status = 'rejected', status_reason = v_reason, submitted_at = null,
         decided_at = now(), decided_by = p_admin_id
   where profile_id = p_carrier_id;
  return 'rejected';
end;
$$;

revoke execute on function public.decide_carrier_review(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.decide_carrier_review(uuid, uuid, boolean, text) to service_role;
