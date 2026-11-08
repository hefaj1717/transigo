-- Stage 3 / migration 2: customer payment (Stripe Checkout), refunds model, webhook idempotency, e-mail outbox.
-- See docs/db-schema.md 3.3–3.4, 3.7 and docs/spec.md D88–D95.
--
-- Rules:
--   * An order becomes "paid" ONLY through confirm_order_payment(), called by the Stripe webhook handler
--     after the signature was verified. The return from Checkout never changes anything.
--   * One Checkout session per order at a time (partial unique index). The session expires together with
--     the order's payment deadline (orders.payment_due_at); "Paga ora" reopens the same session.
--   * payments / refunds / stripe_events / email_outbox: no direct writes from the browser. payments are
--     written only through the SECURITY DEFINER functions below (not even service role writes them directly).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.payment_purpose as enum ('order', 'storage_extension');
create type public.payment_status as enum ('pending', 'succeeded', 'expired', 'failed');
create type public.refund_status as enum ('pending', 'succeeded', 'failed');
create type public.refund_kind as enum ('customer_cancellation', 'admin');
create type public.email_status as enum ('queued', 'sent', 'failed', 'captured_dev');

-- ---------------------------------------------------------------------------
-- settings: payment window (D88) [DO USTALENIA]
-- ---------------------------------------------------------------------------
alter table public.settings
  add column payment_window_minutes integer not null default 60 check (payment_window_minutes between 30 and 1440);

grant update (payment_window_minutes) on public.settings to authenticated; -- admin only (RLS policy)

-- ---------------------------------------------------------------------------
-- orders: payment deadline + cancellation columns (deferred from 2b, D77)
-- ---------------------------------------------------------------------------
alter table public.orders
  add column payment_due_at            timestamptz,
  add column cancellation_requested_at timestamptz,
  add column cancellation_requested_by uuid,          -- no FK (like order_status_history.changed_by)
  add column cancellation_reason       text check (length(cancellation_reason) <= 2000),
  add column cancellation_decided_at   timestamptz,
  add column cancellation_decided_by   uuid;

-- Existing orders (staging): deadline = created_at + 60 min. Unpaid ones in the past will expire.
update public.orders set payment_due_at = created_at + interval '60 minutes' where payment_due_at is null;

alter table public.orders
  alter column payment_due_at set not null,
  add constraint orders_cancellation_review_requested check (status <> 'cancellation_review' or cancellation_requested_at is not null),
  add constraint orders_cancelled_at check (status <> 'cancelled' or cancelled_at is not null);

create index orders_payment_due_idx on public.orders (payment_due_at) where status = 'pending_payment';

-- D88: payment_due_at = least(now + payment_window_minutes, pickup_window_start - min_booking_lead_hours),
-- but never earlier than now + 30 min (minimum lifetime of a Stripe Checkout session). Set once, on insert.
create or replace function public.set_order_payment_due()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_window int;
  v_lead   int;
begin
  select payment_window_minutes, min_booking_lead_hours into v_window, v_lead from public.settings where id;
  new.payment_due_at := greatest(
    now() + interval '30 minutes',
    least(now() + make_interval(mins => coalesce(v_window, 60)),
          new.pickup_window_start - make_interval(hours => coalesce(v_lead, 3)))
  );
  return new;
end;
$$;

create trigger orders_set_payment_due
  before insert on public.orders
  for each row execute function public.set_order_payment_due();

create trigger orders_b_forbid_payment_due_change
  before update on public.orders
  for each row execute function public.forbid_column_changes('payment_due_at');

-- order_charges: late-cancellation fee (D33, D38). Mutable like refunded_cents.
alter table public.order_charges
  add column cancellation_fee_cents integer check (cancellation_fee_cents >= 0 and cancellation_fee_cents <= total_cents);

drop trigger order_charges_a_guard on public.order_charges;
create trigger order_charges_a_guard
  before update on public.order_charges
  for each row execute function public.guard_immutable_columns('refunded_cents', 'cancellation_fee_cents', 'updated_at');

grant update (cancellation_fee_cents) on public.order_charges to service_role;

-- ---------------------------------------------------------------------------
-- payments — one row per Stripe Checkout session
-- ---------------------------------------------------------------------------
create table public.payments (
  id                         uuid primary key default gen_random_uuid(),
  purpose                    public.payment_purpose not null default 'order',
  order_id                   uuid not null references public.orders (id) on delete cascade,
  amount_cents               integer not null check (amount_cents > 0),         -- = order_charges.total_cents
  currency                   char(3) not null default 'eur' check (currency = 'eur'),
  status                     public.payment_status not null default 'pending',
  stripe_checkout_session_id text not null unique,
  stripe_payment_intent_id   text unique,
  stripe_charge_id           text unique,
  transfer_group             text not null,                                     -- = order_number (D90), for Stage 6 transfers
  amount_received_cents      integer check (amount_received_cents >= 0),        -- from the PaymentIntent
  received_currency          char(3),
  review_reason              text check (review_reason in ('amount_mismatch', 'currency_mismatch', 'duplicate_payment', 'late_payment')),
  expires_at                 timestamptz not null,
  paid_at                    timestamptz,
  failure_message            text check (length(failure_message) <= 1000),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  check (status <> 'succeeded' or (paid_at is not null and amount_received_cents is not null))
);

create index payments_order_idx on public.payments (order_id, created_at desc);
create unique index payments_one_open_per_order on public.payments (order_id) where status = 'pending';

create trigger payments_guard
  before update on public.payments
  for each row execute function public.forbid_column_changes(
    'id', 'purpose', 'order_id', 'amount_cents', 'currency', 'stripe_checkout_session_id', 'transfer_group', 'created_at');

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- An order with money received cannot be deleted (for everyone), whatever its status.
create or replace function public.guard_paid_order_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.payments p where p.order_id = old.id and p.status = 'succeeded') then
    raise exception 'Orders with a received payment cannot be deleted' using errcode = '42501';
  end if;
  return old;
end;
$$;

create trigger orders_guard_paid_delete
  before delete on public.orders
  for each row execute function public.guard_paid_order_delete();

-- ---------------------------------------------------------------------------
-- refunds — data model only (the refund button comes in Stage 6)
-- ---------------------------------------------------------------------------
create table public.refunds (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders (id) on delete restrict,
  payment_id       uuid not null references public.payments (id) on delete restrict,
  kind             public.refund_kind not null,
  amount_cents     integer not null check (amount_cents > 0),
  reason           text not null check (length(trim(reason)) between 1 and 2000),
  status           public.refund_status not null default 'pending',
  stripe_refund_id text unique,
  after_payout     boolean not null default false,   -- D5: refund after the payout → cost of Transigo
  created_by       uuid,                             -- admin (no FK, survives account deletion)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index refunds_order_idx on public.refunds (order_id);

create trigger refunds_guard
  before update on public.refunds
  for each row execute function public.forbid_column_changes('id', 'order_id', 'payment_id', 'kind', 'amount_cents', 'created_at');

create trigger refunds_set_updated_at
  before update on public.refunds
  for each row execute function public.set_updated_at();

-- Refunds only for a succeeded payment of the same order; sum of non-failed refunds ≤ payment amount.
-- SECURITY DEFINER: it locks the payment row (FOR UPDATE), which nobody may update directly.
create or replace function public.check_refund_total()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments%rowtype;
  v_sum bigint;
begin
  select * into v_pay from public.payments where id = new.payment_id for update;
  if v_pay.order_id is distinct from new.order_id or v_pay.status <> 'succeeded' then
    raise exception 'Refund must belong to a succeeded payment of the same order' using errcode = '23514';
  end if;
  select coalesce(sum(amount_cents), 0) into v_sum
    from public.refunds where payment_id = new.payment_id and status <> 'failed' and id <> new.id;
  if new.status <> 'failed' and v_sum + new.amount_cents > coalesce(v_pay.amount_received_cents, v_pay.amount_cents) then
    raise exception 'Refunds exceed the payment amount' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger refunds_check_total
  before insert or update on public.refunds
  for each row execute function public.check_refund_total();

-- ---------------------------------------------------------------------------
-- stripe_events — webhook idempotency (each event processed at most once)
-- ---------------------------------------------------------------------------
create table public.stripe_events (
  event_id     text primary key,
  type         text not null,
  livemode     boolean not null,
  account      text,                                 -- Connect events (Stage 4)
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  attempts     smallint not null default 1,
  error        text check (length(error) <= 2000)
);

-- ---------------------------------------------------------------------------
-- email_outbox — every e-mail the app sends (dev: captured instead of sent)
-- ---------------------------------------------------------------------------
create table public.email_outbox (
  id                  uuid primary key default gen_random_uuid(),
  template_code       text not null,
  order_id            uuid references public.orders (id) on delete set null,
  recipient_id        uuid,
  to_address          text not null,
  subject             text not null,
  html                text not null,
  text_body           text not null,
  status              public.email_status not null default 'queued',
  provider_message_id text,
  error               text check (length(error) <= 2000),
  attempts            smallint not null default 0,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  unique (template_code, order_id)                    -- a repeated webhook does not send a second e-mail
);

create index email_outbox_status_idx on public.email_outbox (status, created_at);

-- ---------------------------------------------------------------------------
-- Payment functions (SECURITY DEFINER, service role only)
-- ---------------------------------------------------------------------------

-- Records a new Checkout session for an unpaid order. The amount must equal the order total.
create or replace function public.start_order_payment(
  p_order_id uuid, p_session_id text, p_amount_cents integer, p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_total integer;
  v_id    uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'start_order_payment: order not found' using errcode = 'P0002';
  end if;
  if v_order.status <> 'pending_payment' then
    raise exception 'start_order_payment: order is not awaiting payment (status %)', v_order.status using errcode = '22023';
  end if;
  if now() >= v_order.payment_due_at then
    raise exception 'start_order_payment: payment deadline passed' using errcode = '22023';
  end if;
  select total_cents into v_total from public.order_charges where order_id = p_order_id;
  if p_amount_cents is distinct from v_total then
    raise exception 'start_order_payment: amount % differs from the order total %', p_amount_cents, v_total using errcode = '22023';
  end if;

  insert into public.payments (order_id, amount_cents, stripe_checkout_session_id, transfer_group, expires_at)
  values (p_order_id, p_amount_cents, p_session_id, v_order.order_number, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;

-- Webhook: Stripe says the session is paid. Returns { result: paid | already_processed | review, ... }.
-- "paid" only when the order is awaiting payment and the amount and currency match both the
-- payment row and order_charges.total_cents; anything else → admin check (payment_review), never paid.
create or replace function public.confirm_order_payment(
  p_session_id text, p_payment_intent_id text, p_charge_id text, p_amount_cents integer, p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay    public.payments%rowtype;
  v_order  public.orders%rowtype;
  v_total  integer;
  v_reason text;
begin
  select * into v_pay from public.payments where stripe_checkout_session_id = p_session_id for update;
  if not found then
    raise exception 'confirm_order_payment: unknown Checkout session' using errcode = 'P0002';
  end if;
  select * into v_order from public.orders where id = v_pay.order_id for update;

  if v_pay.status = 'succeeded' then
    return jsonb_build_object('result', 'already_processed', 'order_id', v_order.id, 'order_number', v_order.order_number, 'status', v_order.status);
  end if;

  select total_cents into v_total from public.order_charges where order_id = v_order.id;

  if lower(coalesce(p_currency, '')) <> 'eur' then
    v_reason := 'currency_mismatch';
  elsif p_amount_cents is distinct from v_pay.amount_cents or p_amount_cents is distinct from v_total then
    v_reason := 'amount_mismatch';
  elsif v_order.status = 'expired' then
    v_reason := 'late_payment';
  elsif v_order.status <> 'pending_payment' then
    v_reason := 'duplicate_payment';
  end if;

  update public.payments
     set status = 'succeeded', stripe_payment_intent_id = p_payment_intent_id, stripe_charge_id = p_charge_id,
         amount_received_cents = p_amount_cents, received_currency = lower(p_currency), paid_at = now(),
         review_reason = v_reason
   where id = v_pay.id;

  if v_reason is null then
    update public.orders set status = 'paid', paid_at = now() where id = v_order.id;
    insert into public.order_status_history (order_id, from_status, to_status, source)
    values (v_order.id, v_order.status, 'paid', 'stripe_webhook');
    return jsonb_build_object('result', 'paid', 'order_id', v_order.id, 'order_number', v_order.order_number, 'status', 'paid');
  end if;

  if v_order.status in ('pending_payment', 'expired') then
    update public.orders set status = 'payment_review' where id = v_order.id;
    insert into public.order_status_history (order_id, from_status, to_status, source, note)
    values (v_order.id, v_order.status, 'payment_review', 'stripe_webhook', 'Pagamento da verificare');
    v_order.status := 'payment_review';
  end if;
  return jsonb_build_object('result', 'review', 'reason', v_reason, 'order_id', v_order.id, 'order_number', v_order.order_number, 'status', v_order.status);
end;
$$;

-- Webhook / job: the Checkout session expired. Marks the payment expired; returns the order id (null if unknown).
create or replace function public.expire_order_payment(p_session_id text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments%rowtype;
begin
  select * into v_pay from public.payments where stripe_checkout_session_id = p_session_id for update;
  if not found then
    return null;
  end if;
  if v_pay.status = 'pending' then
    update public.payments set status = 'expired' where id = v_pay.id;
  end if;
  return v_pay.order_id;
end;
$$;

-- Webhook: an asynchronous payment method failed (cards only in the MVP — defensive).
create or replace function public.fail_order_payment(p_session_id text, p_message text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments%rowtype;
begin
  select * into v_pay from public.payments where stripe_checkout_session_id = p_session_id for update;
  if not found then
    return null;
  end if;
  if v_pay.status = 'pending' then
    update public.payments set status = 'failed', failure_message = left(p_message, 1000) where id = v_pay.id;
  end if;
  return v_pay.order_id;
end;
$$;

-- Unpaid order → expired, when it has no open Checkout session and (p_force or the deadline passed;
-- 2 min tolerance for clock differences with Stripe). p_force: customer cancels an unpaid order (D92).
create or replace function public.expire_order(
  p_order_id uuid, p_source public.status_source, p_changed_by uuid default null, p_note text default null, p_force boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.status <> 'pending_payment' then
    return false;
  end if;
  if exists (select 1 from public.payments where order_id = p_order_id and status = 'pending') then
    return false;
  end if;
  if not p_force and now() < v_order.payment_due_at - interval '2 minutes' then
    return false;
  end if;
  update public.orders set status = 'expired' where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, note)
  values (p_order_id, 'pending_payment', 'expired', p_changed_by, p_source, p_note);
  return true;
end;
$$;

-- Job: expires every overdue unpaid order without an open session. Returns the number of expired orders.
create or replace function public.expire_unpaid_orders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n  integer := 0;
begin
  for v_id in
    select o.id from public.orders o
     where o.status = 'pending_payment' and o.payment_due_at <= now() - interval '2 minutes'
       and not exists (select 1 from public.payments p where p.order_id = o.id and p.status = 'pending')
  loop
    if public.expire_order(v_id, 'system_job') then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

revoke execute on function public.start_order_payment(uuid, text, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.confirm_order_payment(text, text, text, integer, text) from public, anon, authenticated;
revoke execute on function public.expire_order_payment(text) from public, anon, authenticated;
revoke execute on function public.fail_order_payment(text, text) from public, anon, authenticated;
revoke execute on function public.expire_order(uuid, public.status_source, uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.expire_unpaid_orders() from public, anon, authenticated;
grant execute on function public.start_order_payment(uuid, text, integer, timestamptz) to service_role;
grant execute on function public.confirm_order_payment(text, text, text, integer, text) to service_role;
grant execute on function public.expire_order_payment(text) to service_role;
grant execute on function public.fail_order_payment(text, text) to service_role;
grant execute on function public.expire_order(uuid, public.status_source, uuid, text, boolean) to service_role;
grant execute on function public.expire_unpaid_orders() to service_role;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.payments, public.refunds, public.stripe_events, public.email_outbox from anon, authenticated, service_role;

-- payments: read by the customer (own) and admin; written only by the functions above.
grant select on public.payments to authenticated, service_role;
-- refunds: read by the customer (own) and admin; written by the server (Stage 6).
grant select on public.refunds to authenticated;
grant select, insert, update on public.refunds to service_role;
-- server only
grant select, insert, update on public.stripe_events, public.email_outbox to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.payments enable row level security;
alter table public.refunds enable row level security;
alter table public.stripe_events enable row level security;  -- no policies: service role only
alter table public.email_outbox enable row level security;   -- no policies: service role only

create policy payments_select on public.payments
  for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.orders o
      where o.id = payments.order_id
        and o.customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente'
    )
  );

create policy refunds_select on public.refunds
  for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.orders o
      where o.id = refunds.order_id
        and o.customer_id = (select auth.uid()) and (select public.auth_role()) = 'cliente'
    )
  );
