-- Customer invoices and credit notes (D144–D149; plan docs/plany/faktury.md, section 3 with the owner-approved
-- changes of 2026-11-11, D150).
--
--   * invoices               one invoice per accepted payment (D26) and one credit note per succeeded refund. The
--                            document itself is issued by the e-invoice provider behind src/lib/einvoice (today the
--                            DEMO adapter, later Fatture in Cloud): row 'pending' → provider (idempotency key = row
--                            id) → record_invoice_result(). A provider error never undoes a payment or a refund.
--   * invoice_demo_counters  counter of the DEMO series only (D145). A real invoice number always comes from the
--                            provider; unique (provider, number) keeps the series apart.
--   * bucket 'invoices'      private PDFs {order_id}/{invoice_id}.pdf; written by the service role only; downloaded
--                            through a 60 s signed URL created with the reader's session (D148).
-- Writes only through the functions below (service role; even the service role has no INSERT / UPDATE on the table).
-- Sessions read: the customer its own documents without the technical columns, the admin everything (technical
-- columns through admin_invoice_errors()), the carrier nothing.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
create type public.invoice_kind       as enum ('invoice', 'credit_note');
create type public.invoice_status     as enum ('pending', 'issued', 'failed');   -- our process; 'issued' is final
create type public.invoice_sdi_status as enum ('not_sent', 'sent', 'delivered', 'rejected');

create table public.invoice_demo_counters (
  series      text    not null check (series in ('DEMO', 'DEMO-NC')),
  year        integer not null check (year between 2020 and 2100),
  last_number integer not null default 0 check (last_number >= 0),
  primary key (series, year)
);

create table public.invoices (
  id                   uuid primary key default gen_random_uuid(),
  kind                 public.invoice_kind not null,
  order_id             uuid not null references public.orders (id) on delete restrict,
  payment_id           uuid not null references public.payments (id) on delete restrict,
  refund_id            uuid unique references public.refunds (id) on delete restrict,      -- credit note: the refund
  invoice_id           uuid references public.invoices (id) on delete restrict,            -- credit note: the invoice
  provider             text not null check (provider in ('demo', 'fatture_in_cloud')),
  is_demo              boolean not null,
  status               public.invoice_status not null default 'pending',
  sdi_status           public.invoice_sdi_status,
  number               text check (length(number) between 1 and 100),   -- from the provider (DEMO: reserved below)
  issued_at            timestamptz,
  provider_document_id text check (length(provider_document_id) <= 200),
  net_cents            integer not null check (net_cents >= 0),
  vat_cents            integer not null check (vat_cents >= 0),
  total_cents          integer not null check (total_cents > 0 and total_cents = net_cents + vat_cents),
  pdf_path             text unique,                                       -- bucket invoices: {order_id}/{id}.pdf
  attempts             integer not null default 0 check (attempts >= 0),
  last_error_code      text check (length(last_error_code) <= 200),       -- a code, never personal data
  last_attempt_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (is_demo = (provider = 'demo')),
  check ((kind = 'invoice') = (refund_id is null)),
  check ((kind = 'invoice') = (invoice_id is null)),
  check (status <> 'issued' or (number is not null and issued_at is not null and sdi_status is not null)),
  check (pdf_path is null or pdf_path = order_id::text || '/' || id::text || '.pdf'),
  unique (provider, number)
);
create unique index invoices_one_per_payment on public.invoices (payment_id) where kind = 'invoice';   -- D26
create index invoices_order_idx on public.invoices (order_id);
create index invoices_credit_notes_idx on public.invoices (invoice_id) where invoice_id is not null;
create index invoices_open_idx on public.invoices (status) where status <> 'issued';

create trigger invoices_a_guard
  before update on public.invoices
  for each row execute function public.forbid_column_changes(
    'id', 'kind', 'order_id', 'payment_id', 'refund_id', 'invoice_id', 'provider', 'is_demo',
    'net_cents', 'vat_cents', 'total_cents', 'created_at');

-- 'issued' is final: afterwards only the SDI status can change. A reserved / assigned number never changes.
create function public.invoices_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.number is not null and new.number is distinct from old.number then
    raise exception 'invoices: the number cannot be changed' using errcode = '42501';
  end if;
  if old.status = 'issued' and (
       new.status <> 'issued' or new.issued_at is distinct from old.issued_at
       or new.provider_document_id is distinct from old.provider_document_id or new.pdf_path is distinct from old.pdf_path) then
    raise exception 'invoices: an issued document is final' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger invoices_b_status_guard
  before update on public.invoices
  for each row execute function public.invoices_status_guard();

create trigger invoices_set_updated_at
  before update on public.invoices
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
revoke all on public.invoices, public.invoice_demo_counters from anon, authenticated, service_role;
grant select (id, kind, order_id, payment_id, refund_id, invoice_id, provider, is_demo, status, sdi_status, number,
              issued_at, net_cents, vat_cents, total_cents, pdf_path, created_at, updated_at)
  on public.invoices to authenticated;
grant select on public.invoices, public.invoice_demo_counters to service_role;

alter table public.invoices enable row level security;
alter table public.invoice_demo_counters enable row level security;   -- no policies: functions only

create policy invoices_select on public.invoices
  for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.orders o
      where o.id = invoices.order_id
        and o.customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente'
    )
  );

-- ---------------------------------------------------------------------------
-- Storage: private bucket; no session writes. Read: the customer — the PDF of its issued document; the admin — all.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 5242880, array['application/pdf'])
on conflict (id) do nothing;

create policy invoices_storage_select_customer on storage.objects
  for select to authenticated
  using (
    bucket_id = 'invoices' and (select public.auth_role()) = 'cliente'
    and exists (
      select 1 from public.invoices i join public.orders o on o.id = i.order_id
      where i.pdf_path = name and i.status = 'issued' and o.customer_id = (select auth.uid())
    )
  );
create policy invoices_storage_select_admin on storage.objects
  for select to authenticated
  using (bucket_id = 'invoices' and (select public.is_admin()));

-- ---------------------------------------------------------------------------
-- queue_invoice(payment, provider) → (invoice_id, newly_queued)
-- The payment must be the order's accepted payment (order_main_payment). Amounts from order_charges. A second call
-- (also concurrent) returns the same row — even if the provider has changed meanwhile (the server checks that).
-- Errors: 22023 payment / provider | 55000 payment_not_accepted
-- ---------------------------------------------------------------------------
create function public.queue_invoice(p_payment_id uuid, p_provider text)
returns table (invoice_id uuid, newly_queued boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_pay     public.payments%rowtype;
  v_main    uuid;
  v_charges public.order_charges%rowtype;
  v_id      uuid;
begin
  if p_provider is null or p_provider not in ('demo', 'fatture_in_cloud') then
    raise exception 'queue_invoice: unknown provider' using errcode = '22023', detail = 'provider';
  end if;
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'queue_invoice: payment not found' using errcode = '22023', detail = 'payment';
  end if;
  select i.id into v_id from public.invoices i where i.payment_id = p_payment_id and i.kind = 'invoice';
  if found then
    return query select v_id, false;
    return;
  end if;
  select (public.order_main_payment(v_pay.order_id)).id into v_main;
  if v_main is distinct from v_pay.id then
    raise exception 'queue_invoice: payment is not the accepted payment of its order' using errcode = '55000', detail = 'payment_not_accepted';
  end if;
  select * into v_charges from public.order_charges where order_id = v_pay.order_id;
  insert into public.invoices (kind, order_id, payment_id, provider, is_demo, net_cents, vat_cents, total_cents)
  values ('invoice', v_pay.order_id, v_pay.id, p_provider, p_provider = 'demo', v_charges.subtotal_cents, v_charges.vat_cents, v_charges.total_cents)
  returning id into v_id;
  return query select v_id, true;
end;
$$;

-- ---------------------------------------------------------------------------
-- queue_credit_note(refund) → (invoice_id, newly_queued)   (D146)
-- The refund must be succeeded and the invoice of its payment issued. Same provider as the invoice. Amounts:
-- gross = refund; VAT cumulative so that all notes of an invoice add up exactly to it (D150):
--   vat = round_half_up(cum_gross × invoice_vat / invoice_total) − VAT of the earlier notes, net = gross − vat
-- where cum_gross = earlier notes + this refund. A second call returns the same row.
-- Errors: 22023 refund | 55000 refund_not_succeeded / invoice_not_issued / exceeds_invoice
-- ---------------------------------------------------------------------------
create function public.queue_credit_note(p_refund_id uuid)
returns table (invoice_id uuid, newly_queued boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_refund   public.refunds%rowtype;
  v_inv      public.invoices%rowtype;
  v_prev_tot bigint;
  v_prev_vat bigint;
  v_cum      bigint;
  v_vat      integer;
  v_id       uuid;
begin
  select * into v_refund from public.refunds where id = p_refund_id;
  if not found then
    raise exception 'queue_credit_note: refund not found' using errcode = '22023', detail = 'refund';
  end if;
  if v_refund.status <> 'succeeded' then
    raise exception 'queue_credit_note: refund not succeeded' using errcode = '55000', detail = 'refund_not_succeeded';
  end if;
  -- The invoice row lock serialises the notes of one invoice (cumulative amounts).
  select * into v_inv from public.invoices i where i.payment_id = v_refund.payment_id and i.kind = 'invoice' for update;
  if not found or v_inv.status <> 'issued' then
    raise exception 'queue_credit_note: the invoice of this payment is not issued' using errcode = '55000', detail = 'invoice_not_issued';
  end if;
  select i.id into v_id from public.invoices i where i.refund_id = p_refund_id;
  if found then
    return query select v_id, false;
    return;
  end if;

  select coalesce(sum(i.total_cents), 0), coalesce(sum(i.vat_cents), 0) into v_prev_tot, v_prev_vat
    from public.invoices i where i.invoice_id = v_inv.id;
  v_cum := v_prev_tot + v_refund.amount_cents;
  if v_cum > v_inv.total_cents then
    raise exception 'queue_credit_note: credit notes would exceed the invoice' using errcode = '55000', detail = 'exceeds_invoice';
  end if;
  -- round half up of a non-negative fraction: floor((2·a·b + c) / (2·c))
  v_vat := ((2 * v_cum * v_inv.vat_cents + v_inv.total_cents) / (2 * v_inv.total_cents) - v_prev_vat)::integer;

  insert into public.invoices (kind, order_id, payment_id, refund_id, invoice_id, provider, is_demo, net_cents, vat_cents, total_cents)
  values ('credit_note', v_inv.order_id, v_inv.payment_id, v_refund.id, v_inv.id, v_inv.provider, v_inv.is_demo,
          v_refund.amount_cents - v_vat, v_vat, v_refund.amount_cents)
  returning id into v_id;
  return query select v_id, true;
end;
$$;

-- ---------------------------------------------------------------------------
-- reserve_demo_invoice_number(invoice) → text   (D145, D150)
-- DEMO adapter only: the number of THIS row (DEMO-2026-0001 / DEMO-NC-2026-0001, year in Europe/Rome). Reserved once
-- under the row lock; a retry gets the same number, so the series has no gaps and no document gets two numbers.
-- Errors: 22023 invoice | 55000 not_demo
-- ---------------------------------------------------------------------------
create function public.reserve_demo_invoice_number(p_invoice_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv    public.invoices%rowtype;
  v_series text;
  v_year   integer := extract(year from (now() at time zone 'Europe/Rome'))::integer;
  v_n      integer;
  v_number text;
begin
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'reserve_demo_invoice_number: invoice not found' using errcode = '22023', detail = 'invoice';
  end if;
  if v_inv.provider <> 'demo' then
    raise exception 'reserve_demo_invoice_number: not a DEMO document' using errcode = '55000', detail = 'not_demo';
  end if;
  if v_inv.number is not null then
    return v_inv.number;
  end if;
  v_series := case v_inv.kind when 'invoice' then 'DEMO' else 'DEMO-NC' end;
  insert into public.invoice_demo_counters as c (series, year, last_number) values (v_series, v_year, 1)
  on conflict (series, year) do update set last_number = c.last_number + 1
  returning last_number into v_n;
  v_number := v_series || '-' || v_year || '-' || lpad(v_n::text, 4, '0');
  update public.invoices set number = v_number where id = p_invoice_id;
  return v_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_invoice_result → boolean (true when the row changed)
--   pending / failed → issued (final) or failed (attempts + 1, error code); issued → false, nothing changes.
--   A number already reserved must match. pdf_path must be {order_id}/{id}.pdf (table check).
-- Errors: 22023 invoice / result | 55000 number_mismatch
-- ---------------------------------------------------------------------------
create function public.record_invoice_result(
  p_invoice_id uuid, p_ok boolean, p_number text, p_issued_at timestamptz, p_provider_document_id text,
  p_sdi_status public.invoice_sdi_status, p_pdf_path text, p_error_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invoices%rowtype;
begin
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'record_invoice_result: invoice not found' using errcode = '22023', detail = 'invoice';
  end if;
  if v_inv.status = 'issued' then
    return false;
  end if;
  if p_ok is null then
    raise exception 'record_invoice_result: missing outcome' using errcode = '22023', detail = 'result';
  end if;

  if p_ok then
    if p_number is null or p_issued_at is null then
      raise exception 'record_invoice_result: number and issue date are required' using errcode = '22023', detail = 'result';
    end if;
    if v_inv.number is not null and v_inv.number <> p_number then
      raise exception 'record_invoice_result: number differs from the reserved one' using errcode = '55000', detail = 'number_mismatch';
    end if;
    update public.invoices
       set status = 'issued', number = p_number, issued_at = p_issued_at, provider_document_id = p_provider_document_id,
           sdi_status = coalesce(p_sdi_status, 'not_sent'), pdf_path = p_pdf_path,
           attempts = attempts + 1, last_error_code = null, last_attempt_at = now()
     where id = p_invoice_id;
    return true;
  end if;

  if p_error_code is null or length(trim(p_error_code)) = 0 then
    raise exception 'record_invoice_result: error code required' using errcode = '22023', detail = 'result';
  end if;
  update public.invoices
     set status = 'failed', attempts = attempts + 1, last_error_code = left(p_error_code, 200), last_attempt_at = now()
   where id = p_invoice_id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_invoice_sdi_status → boolean; issued documents only.
-- Errors: 22023 invoice | 55000 not_issued
-- ---------------------------------------------------------------------------
create function public.record_invoice_sdi_status(p_invoice_id uuid, p_sdi_status public.invoice_sdi_status)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invoices%rowtype;
begin
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found or p_sdi_status is null then
    raise exception 'record_invoice_sdi_status: invoice not found' using errcode = '22023', detail = 'invoice';
  end if;
  if v_inv.status <> 'issued' then
    raise exception 'record_invoice_sdi_status: document not issued' using errcode = '55000', detail = 'not_issued';
  end if;
  if v_inv.sdi_status = p_sdi_status then
    return false;
  end if;
  update public.invoices set sdi_status = p_sdi_status where id = p_invoice_id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_retry_invoice(invoice, admin) → (invoice_id, newly_queued)
--   failed → pending (audit, no free text); pending → the same row, false; issued → 55000 already_issued.
-- Errors: 42501 | 22023 invoice | 55000 already_issued
-- ---------------------------------------------------------------------------
create function public.admin_retry_invoice(p_invoice_id uuid, p_admin_id uuid)
returns table (invoice_id uuid, newly_queued boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email text := public.require_admin(p_admin_id);
  v_inv   public.invoices%rowtype;
begin
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'admin_retry_invoice: invoice not found' using errcode = '22023', detail = 'invoice';
  end if;
  if v_inv.status = 'issued' then
    raise exception 'admin_retry_invoice: already issued' using errcode = '55000', detail = 'already_issued';
  end if;
  if v_inv.status = 'pending' then
    return query select v_inv.id, false;
    return;
  end if;
  update public.invoices set status = 'pending' where id = p_invoice_id;
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'invoice.retried', 'invoice', v_inv.id,
          jsonb_build_object('order_id', v_inv.order_id, 'kind', v_inv.kind, 'attempts', v_inv.attempts, 'last_error_code', v_inv.last_error_code));
  return query select v_inv.id, true;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_invoice_errors(order) — technical columns for the admin session (all orders when p_order_id is null).
-- Errors: 42501
-- ---------------------------------------------------------------------------
create function public.admin_invoice_errors(p_order_id uuid default null)
returns table (invoice_id uuid, provider_document_id text, attempts integer, last_error_code text, last_attempt_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  return query
    select i.id, i.provider_document_id, i.attempts, i.last_error_code, i.last_attempt_at
      from public.invoices i
     where p_order_id is null or i.order_id = p_order_id
     order by i.created_at;
end;
$$;

revoke execute on function public.invoices_status_guard() from public, anon, authenticated;
revoke execute on function public.queue_invoice(uuid, text) from public, anon, authenticated;
revoke execute on function public.queue_credit_note(uuid) from public, anon, authenticated;
revoke execute on function public.reserve_demo_invoice_number(uuid) from public, anon, authenticated;
revoke execute on function public.record_invoice_result(uuid, boolean, text, timestamptz, text, public.invoice_sdi_status, text, text) from public, anon, authenticated;
revoke execute on function public.record_invoice_sdi_status(uuid, public.invoice_sdi_status) from public, anon, authenticated;
revoke execute on function public.admin_retry_invoice(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.admin_invoice_errors(uuid) from public, anon;
grant execute on function public.queue_invoice(uuid, text) to service_role;
grant execute on function public.queue_credit_note(uuid) to service_role;
grant execute on function public.reserve_demo_invoice_number(uuid) to service_role;
grant execute on function public.record_invoice_result(uuid, boolean, text, timestamptz, text, public.invoice_sdi_status, text, text) to service_role;
grant execute on function public.record_invoice_sdi_status(uuid, public.invoice_sdi_status) to service_role;
grant execute on function public.admin_retry_invoice(uuid, uuid) to service_role;
grant execute on function public.admin_invoice_errors(uuid) to authenticated;
