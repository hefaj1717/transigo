-- Stage 1 / migration 4: legal consents and registration rules
-- Decisions D42 (consents), D43 (private customer registration), D44 (business customer registration).
-- See docs/db-schema.md sections 3.1, 3.2.

-- ---------------------------------------------------------------------------
-- profiles: separate Terms and Privacy consents, each with the accepted document version (D42)
-- privacy_accepted_at already exists (migration 1).
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column terms_accepted_at timestamptz,
  add column terms_version     text,
  add column privacy_version   text,
  add constraint profiles_terms_consent_check
    check ((terms_accepted_at is null) = (terms_version is null)),
  add constraint profiles_privacy_consent_check
    check ((privacy_accepted_at is null) = (privacy_version is null));

-- Consent columns are server-only (set by the sign-up Server Action with the service role).
-- Re-create the protection trigger with the extended column list.
drop trigger profiles_a_protect_columns on public.profiles;

create trigger profiles_a_protect_columns
  before update on public.profiles
  for each row execute function public.protect_server_columns(
    'id', 'role', 'email', 'is_blocked',
    'terms_accepted_at', 'terms_version', 'privacy_accepted_at', 'privacy_version',
    'created_at');

-- No grant changes needed: authenticated may update only (first_name, last_name, phone) on profiles.

-- ---------------------------------------------------------------------------
-- settings: current versions of the legal documents (D42)
-- Text, e.g. '2026-11-01'. Changing a version here does not (yet) force re-consent; that is a separate decision.
-- ---------------------------------------------------------------------------
alter table public.settings
  add column terms_version   text not null default '2026-11-01' check (length(trim(terms_version)) > 0),
  add column privacy_version text not null default '2026-11-01' check (length(trim(privacy_version)) > 0);

grant update (terms_version, privacy_version) on public.settings to authenticated; -- RLS: admin only

-- ---------------------------------------------------------------------------
-- customers
-- D43: a private customer registers without codice fiscale; it is collected in "Riepilogo"
--      before payment and the server refuses to create a Checkout session without it (Stage 2/3).
-- D44: a business customer needs an e-invoicing channel: codice SDI or PEC.
-- ---------------------------------------------------------------------------
alter table public.customers
  drop constraint customers_private_fields_check;

alter table public.customers
  add constraint customers_business_einvoice_check
    check (customer_type <> 'business' or sdi_code is not null or pec is not null);
