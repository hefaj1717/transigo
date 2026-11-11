-- Admin money decisions (D140–D142; plan docs/plany/panel-admina.md, part A).
--
--   * order_cancellation_decisions  the admin's decision on a cancellation request (cancellation_review): refund for
--                                   the customer and the amount for the carrier (D40 payout in Stage 6). Admin-only
--                                   table — customers read whole `orders` rows, so the carrier's share stays out of it
--                                   (D77).
--   * payments.reviewed_at / review_outcome  a payment_review payment the admin decided on (D141). No reviewed_by:
--                                   customers read their payments; the author is in audit_log.
--   * refunds.retry_of              a new attempt for a failed refund (one per failed row).
--   * refunds.created_by            no longer readable by sessions (column grant, like D128) — the customer must not
--                                   see admin ids; the service role and audit_log keep it.
-- Functions (service role only; the Server Action checks the admin session first, require_admin() checks again;
-- amounts are checked here under the order row lock; audit_log in the same transaction, ids / codes / amounts only):
--   * admin_decide_cancellation(order, admin, refund, carrier)  cancellation_review → cancelled (D140)
--   * admin_resolve_payment_review(payment, admin, action)      mark_paid | refund (D141)
--   * admin_refund_order(order, admin, amount, reason)          manual full / partial refund (D142)
--   * admin_retry_refund(refund, admin)                         pending → the same row again; failed → a new row
-- The Stripe call happens on the server after the function: refund row → Refund with idempotency key refund:<id> →
-- record_refund_result() (as D137). A Stripe error never undoes the decision.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
create table public.order_cancellation_decisions (
  order_id      uuid primary key references public.orders (id) on delete restrict,
  refund_cents  integer not null check (refund_cents >= 0),
  carrier_cents integer not null check (carrier_cents >= 0),
  decided_at    timestamptz not null default now()
);
create trigger order_cancellation_decisions_no_update
  before update on public.order_cancellation_decisions
  for each row execute function public.reject_change();

revoke all on public.order_cancellation_decisions from anon, authenticated, service_role;
grant select on public.order_cancellation_decisions to authenticated, service_role;
alter table public.order_cancellation_decisions enable row level security;
create policy order_cancellation_decisions_select_admin on public.order_cancellation_decisions
  for select to authenticated
  using ((select public.is_admin()));

alter table public.payments
  add column reviewed_at    timestamptz,
  add column review_outcome text check (review_outcome in ('accepted', 'refunded')),
  add constraint payments_review_decision check ((reviewed_at is null) = (review_outcome is null)),
  add constraint payments_review_needs_reason check (review_outcome is null or review_reason is not null);

alter table public.refunds
  add column retry_of uuid unique references public.refunds (id) on delete restrict;
-- retry_of is set once, on insert.
drop trigger refunds_guard on public.refunds;
create trigger refunds_guard
  before update on public.refunds
  for each row execute function public.forbid_column_changes('id', 'order_id', 'payment_id', 'kind', 'amount_cents', 'created_at', 'retry_of');

revoke select on public.refunds from authenticated;
grant select (id, order_id, payment_id, kind, amount_cents, reason, status, stripe_refund_id, after_payout, retry_of, created_at, updated_at)
  on public.refunds to authenticated;

comment on column public.orders.cancellation_decided_by is
  'Set only for automatic decisions (null). Admin decisions (D140) keep the author in audit_log — customers read this row.';

-- ---------------------------------------------------------------------------
-- order_main_payment(order): the payment the order stands on — succeeded and either never in review or accepted by
-- the admin. Null for an order without one (e.g. still in payment_review).
-- ---------------------------------------------------------------------------
create function public.order_main_payment(p_order_id uuid)
returns public.payments
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from public.payments p
   where p.order_id = p_order_id and p.status = 'succeeded'
     and (p.review_reason is null or p.review_outcome = 'accepted')
   order by p.paid_at
   limit 1;
$$;

-- Still refundable on a payment: received − refunds that are not failed.
create function public.payment_refundable_cents(p_payment_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(coalesce(p.amount_received_cents, p.amount_cents)
                  - coalesce((select sum(r.amount_cents) from public.refunds r where r.payment_id = p.id and r.status <> 'failed'), 0), 0)::integer
    from public.payments p where p.id = p_payment_id;
$$;

-- ---------------------------------------------------------------------------
-- admin_decide_cancellation (D140)
-- Errors: 42501 | 22023 order / refund_amount / carrier_amount | 55000 not_in_review / no_payment
-- ---------------------------------------------------------------------------
create function public.admin_decide_cancellation(p_order_id uuid, p_admin_id uuid, p_refund_cents integer, p_carrier_cents integer)
returns table (
  result            text,      -- 'cancelled' | 'already_decided'
  refund_id         uuid,
  refund_cents      integer,
  payment_intent_id text,
  order_number      text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email      text := public.require_admin(p_admin_id);
  v_order      public.orders%rowtype;
  v_charges    public.order_charges%rowtype;
  v_pay        public.payments%rowtype;
  v_decision   public.order_cancellation_decisions%rowtype;
  v_refundable integer;
  v_refunded   bigint;
  v_carrier    integer;
  v_refund_id  uuid;
  v_now        timestamptz := now();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'admin_decide_cancellation: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.status = 'cancelled' then
    select * into v_decision from public.order_cancellation_decisions where order_id = p_order_id;
    if found then
      return query select 'already_decided'::text, null::uuid, v_decision.refund_cents, null::text, v_order.order_number;
      return;
    end if;
  end if;
  if v_order.status <> 'cancellation_review' then
    raise exception 'admin_decide_cancellation: order not in cancellation_review' using errcode = '55000', detail = 'not_in_review';
  end if;

  select * into v_charges from public.order_charges where order_id = p_order_id for update;
  select * into v_pay from public.order_main_payment(p_order_id);
  if v_pay.id is null then
    raise exception 'admin_decide_cancellation: no payment' using errcode = '55000', detail = 'no_payment';
  end if;
  v_refundable := public.payment_refundable_cents(v_pay.id);
  if p_refund_cents is null or p_refund_cents < 0 or p_refund_cents > v_refundable then
    raise exception 'admin_decide_cancellation: refund must be 0–% cents', v_refundable using errcode = '22023', detail = 'refund_amount';
  end if;
  select coalesce(sum(t.carrier_amount_cents), 0) into v_carrier from public.order_leg_carrier_terms t where t.order_id = p_order_id;
  if p_carrier_cents is null or p_carrier_cents < 0 or p_carrier_cents > v_carrier then
    raise exception 'admin_decide_cancellation: carrier amount must be 0–% cents', v_carrier using errcode = '22023', detail = 'carrier_amount';
  end if;

  select coalesce(sum(r.amount_cents), 0) into v_refunded from public.refunds r where r.order_id = p_order_id and r.status <> 'failed';

  update public.orders
     set status = 'cancelled', cancelled_at = v_now, cancellation_decided_at = v_now, cancellation_decided_by = null
   where id = p_order_id;
  update public.order_charges
     set cancellation_fee_cents = greatest(v_charges.total_cents - v_refunded - p_refund_cents, 0)
   where order_id = p_order_id;
  insert into public.order_cancellation_decisions (order_id, refund_cents, carrier_cents, decided_at)
  values (p_order_id, p_refund_cents, p_carrier_cents, v_now);
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
  values (p_order_id, 'cancellation_review', 'cancelled', p_admin_id, 'admin_panel', v_now);

  if p_refund_cents > 0 then
    insert into public.refunds (order_id, payment_id, kind, amount_cents, reason, created_by, created_at)
    values (p_order_id, v_pay.id, 'customer_cancellation', p_refund_cents, 'cancellation_decision', p_admin_id, v_now)
    returning id into v_refund_id;
  end if;

  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.cancellation_decided', 'order', p_order_id,
          jsonb_build_object('refund_cents', p_refund_cents, 'carrier_cents', p_carrier_cents, 'refund_id', v_refund_id));

  return query select 'cancelled'::text, v_refund_id, p_refund_cents, v_pay.stripe_payment_intent_id, v_order.order_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_resolve_payment_review (D141), p_action: 'mark_paid' | 'refund'
--   mark_paid  only an order in payment_review (not a duplicate payment): order → paid, payment accepted.
--   refund     the whole remainder of THIS payment; an order in payment_review → refunded; a duplicate payment
--              leaves the order as it is.
-- Errors: 42501 | 22023 payment / action | 55000 not_in_review / duplicate_payment
-- ---------------------------------------------------------------------------
create function public.admin_resolve_payment_review(p_payment_id uuid, p_admin_id uuid, p_action text)
returns table (
  result            text,      -- 'paid' | 'refunded' | 'already_resolved'
  refund_id         uuid,
  refund_cents      integer,
  payment_intent_id text,
  order_id          uuid,
  order_number      text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email   text := public.require_admin(p_admin_id);
  v_pay     public.payments%rowtype;
  v_order   public.orders%rowtype;
  v_amount  integer;
  v_refund  uuid;
  v_now     timestamptz := now();
begin
  if p_action is null or p_action not in ('mark_paid', 'refund') then
    raise exception 'admin_resolve_payment_review: unknown action' using errcode = '22023', detail = 'action';
  end if;
  -- Lock order: payment, then order — as confirm_order_payment().
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found or v_pay.status <> 'succeeded' or v_pay.review_reason is null then
    raise exception 'admin_resolve_payment_review: payment not in review' using errcode = '22023', detail = 'payment';
  end if;
  select * into v_order from public.orders where id = v_pay.order_id for update;
  if v_pay.reviewed_at is not null then
    return query select 'already_resolved'::text, null::uuid, null::integer, v_pay.stripe_payment_intent_id, v_order.id, v_order.order_number;
    return;
  end if;

  if p_action = 'mark_paid' then
    if v_pay.review_reason = 'duplicate_payment' then
      raise exception 'admin_resolve_payment_review: a duplicate payment can only be refunded' using errcode = '55000', detail = 'duplicate_payment';
    end if;
    if v_order.status <> 'payment_review' then
      raise exception 'admin_resolve_payment_review: order not in payment_review' using errcode = '55000', detail = 'not_in_review';
    end if;
    update public.payments set reviewed_at = v_now, review_outcome = 'accepted' where id = v_pay.id;
    update public.orders set status = 'paid', paid_at = v_pay.paid_at where id = v_order.id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
    values (v_order.id, 'payment_review', 'paid', p_admin_id, 'admin_panel', v_now);
    insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
    values (p_admin_id, v_email, 'payment.review_accepted', 'payment', v_pay.id,
            jsonb_build_object('order_id', v_order.id, 'review_reason', v_pay.review_reason));
    return query select 'paid'::text, null::uuid, null::integer, v_pay.stripe_payment_intent_id, v_order.id, v_order.order_number;
    return;
  end if;

  v_amount := public.payment_refundable_cents(v_pay.id);
  update public.payments set reviewed_at = v_now, review_outcome = 'refunded' where id = v_pay.id;
  if v_amount > 0 then
    insert into public.refunds (order_id, payment_id, kind, amount_cents, reason, created_by, created_at)
    values (v_order.id, v_pay.id, 'admin', v_amount, 'payment_review', p_admin_id, v_now)
    returning id into v_refund;
  end if;
  if v_order.status = 'payment_review' then
    update public.orders set status = 'refunded' where id = v_order.id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
    values (v_order.id, 'payment_review', 'refunded', p_admin_id, 'admin_panel', v_now);
  end if;
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'payment.review_refunded', 'payment', v_pay.id,
          jsonb_build_object('order_id', v_order.id, 'review_reason', v_pay.review_reason, 'refund_cents', v_amount, 'refund_id', v_refund));
  return query select 'refunded'::text, v_refund, v_amount, v_pay.stripe_payment_intent_id, v_order.id, v_order.order_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_refund_order (D142)
-- Partial: any paid order (paid … completed, cancelled), status unchanged. Full (nothing left after it): paid /
-- delivered / completed → refunded; cancelled stays cancelled; a job in progress must be unassigned first.
-- Errors: 42501 | 22023 order / reason / amount | 55000 not_refundable / no_payment / in_progress
-- ---------------------------------------------------------------------------
create function public.admin_refund_order(p_order_id uuid, p_admin_id uuid, p_amount_cents integer, p_reason_code text)
returns table (
  refund_id         uuid,
  full_refund       boolean,
  new_status        public.order_status,
  payment_intent_id text,
  order_number      text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email      text := public.require_admin(p_admin_id);
  v_order      public.orders%rowtype;
  v_pay        public.payments%rowtype;
  v_refundable integer;
  v_full       boolean;
  v_status     public.order_status;
  v_refund     uuid;
  v_now        timestamptz := now();
begin
  if p_reason_code is null or p_reason_code not in ('service_issue', 'claim', 'goodwill', 'price_correction', 'other') then
    raise exception 'admin_refund_order: unknown reason' using errcode = '22023', detail = 'reason';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'admin_refund_order: order not found' using errcode = '22023', detail = 'order';
  end if;
  if v_order.status not in ('paid', 'assigned', 'picked_up', 'in_transit', 'delivered', 'completed', 'cancelled') then
    raise exception 'admin_refund_order: status % cannot be refunded here', v_order.status using errcode = '55000', detail = 'not_refundable';
  end if;
  select * into v_pay from public.order_main_payment(p_order_id);
  if v_pay.id is null then
    raise exception 'admin_refund_order: no payment' using errcode = '55000', detail = 'no_payment';
  end if;
  perform 1 from public.payments where id = v_pay.id for update;
  v_refundable := public.payment_refundable_cents(v_pay.id);
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > v_refundable then
    raise exception 'admin_refund_order: amount must be 1–% cents', v_refundable using errcode = '22023', detail = 'amount';
  end if;

  v_full := p_amount_cents = v_refundable;
  v_status := v_order.status;
  if v_full and v_order.status in ('assigned', 'picked_up', 'in_transit') then
    raise exception 'admin_refund_order: unassign the carrier before a full refund' using errcode = '55000', detail = 'in_progress';
  end if;
  if v_full and v_order.status in ('paid', 'delivered', 'completed') then
    v_status := 'refunded';
    update public.orders set status = 'refunded' where id = p_order_id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
    values (p_order_id, v_order.status, 'refunded', p_admin_id, 'admin_panel', v_now);
  end if;

  insert into public.refunds (order_id, payment_id, kind, amount_cents, reason, created_by, created_at)
  values (p_order_id, v_pay.id, 'admin', p_amount_cents, p_reason_code, p_admin_id, v_now)
  returning id into v_refund;
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'order.refunded', 'order', p_order_id,
          jsonb_build_object('refund_id', v_refund, 'amount_cents', p_amount_cents, 'reason', p_reason_code, 'full', v_full,
                             'from_status', v_order.status, 'to_status', v_status));
  return query select v_refund, v_full, v_status, v_pay.stripe_payment_intent_id, v_order.order_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_retry_refund (D142)
--   pending   → the same row (the server calls Stripe again with the same idempotency key), newly_created = false;
--   failed    → a new pending row for the same amount (retry_of = the failed row); a second click returns it;
--   succeeded → 55000 already_succeeded.
-- Errors: 42501 | 22023 refund | 55000 already_succeeded
-- ---------------------------------------------------------------------------
create function public.admin_retry_refund(p_refund_id uuid, p_admin_id uuid)
returns table (
  refund_id         uuid,
  amount_cents      integer,
  payment_intent_id text,
  order_id          uuid,
  newly_created     boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email  text := public.require_admin(p_admin_id);
  v_refund public.refunds%rowtype;
  v_retry  public.refunds%rowtype;
  v_pi     text;
begin
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'admin_retry_refund: refund not found' using errcode = '22023', detail = 'refund';
  end if;
  select p.stripe_payment_intent_id into v_pi from public.payments p where p.id = v_refund.payment_id;

  if v_refund.status = 'succeeded' then
    raise exception 'admin_retry_refund: refund already succeeded' using errcode = '55000', detail = 'already_succeeded';
  end if;
  if v_refund.status = 'pending' then
    return query select v_refund.id, v_refund.amount_cents, v_pi, v_refund.order_id, false;
    return;
  end if;

  select * into v_retry from public.refunds where retry_of = v_refund.id;
  if found then
    return query select v_retry.id, v_retry.amount_cents, v_pi, v_retry.order_id, false;
    return;
  end if;
  insert into public.refunds (order_id, payment_id, kind, amount_cents, reason, created_by, retry_of)
  values (v_refund.order_id, v_refund.payment_id, v_refund.kind, v_refund.amount_cents, v_refund.reason, p_admin_id, v_refund.id)
  returning * into v_retry;
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, data)
  values (p_admin_id, v_email, 'refund.retried', 'refund', v_retry.id,
          jsonb_build_object('order_id', v_refund.order_id, 'failed_refund_id', v_refund.id, 'amount_cents', v_refund.amount_cents));
  return query select v_retry.id, v_retry.amount_cents, v_pi, v_retry.order_id, true;
end;
$$;

revoke execute on function public.order_main_payment(uuid) from public, anon, authenticated;
revoke execute on function public.payment_refundable_cents(uuid) from public, anon, authenticated;
revoke execute on function public.admin_decide_cancellation(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke execute on function public.admin_resolve_payment_review(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_refund_order(uuid, uuid, integer, text) from public, anon, authenticated;
revoke execute on function public.admin_retry_refund(uuid, uuid) from public, anon, authenticated;
grant execute on function public.order_main_payment(uuid) to service_role;
grant execute on function public.payment_refundable_cents(uuid) to service_role;
grant execute on function public.admin_decide_cancellation(uuid, uuid, integer, integer) to service_role;
grant execute on function public.admin_resolve_payment_review(uuid, uuid, text) to service_role;
grant execute on function public.admin_refund_order(uuid, uuid, integer, text) to service_role;
grant execute on function public.admin_retry_refund(uuid, uuid) to service_role;
