-- Customer cancellation of a paid order (D33, D38, D41, D137; plan docs/plany/panel-klienta-2.md, part A).
--
--   * order_late_cancellation_fee(order, bp): the late-cancellation fee — bp of the gross order lines except storage
--     (D38: storage that has not started is refunded in full), rounded half up to the cent. The same rule lives in
--     src/lib/orders/cancellation.ts for the preview; tests/rls/customer-cancellation.test.ts checks both on the
--     same examples.
--   * customer_cancel_order(order, customer, reason): the only way a customer cancels a paid order.
--       paid      → cancelled at once; free ≥ settings.free_cancellation_hours before pickup_window_start, otherwise
--                   the fee (settings.late_cancellation_fee_bp); a pending `refunds` row for the rest (when > 0) —
--                   the server then refunds it in Stripe and records the result.
--       assigned  → cancellation_review (the admin decides the refund and any carrier amount — D33, step 3).
--       cancelled / cancellation_review → returned as they are (a repeated click changes nothing).
--       anything else → 55000 not_cancellable (from picked_up: contact / claim).
--     The amount is computed here, under the order row lock and with the database clock — never taken from the caller.
--   * record_refund_result(refund, stripe refund id, status): the Stripe outcome of a refund; `succeeded` adds the
--     amount to order_charges.refunded_cents exactly once. Used after the Refund call and by the webhook
--     (refund.updated).
-- All three: service role only (the Server Action checks the customer session first; the function checks again that
-- the order belongs to an active, not blocked customer). No new tables, no policy changes.

-- ---------------------------------------------------------------------------
-- Fee (D38): half up, integers only.
-- ---------------------------------------------------------------------------
create function public.order_late_cancellation_fee(p_order_id uuid, p_fee_bp integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select ((coalesce(sum(l.gross_cents), 0)::bigint * p_fee_bp + 5000) / 10000)::integer
    from public.order_lines l
   where l.order_id = p_order_id and l.line_type <> 'storage';
$$;

-- ---------------------------------------------------------------------------
-- customer_cancel_order
-- ---------------------------------------------------------------------------
create function public.customer_cancel_order(p_order_id uuid, p_customer_id uuid, p_reason text default null)
returns table (
  result            text,     -- 'cancelled' | 'review' | 'already_cancelled' | 'already_in_review'
  fee_cents         integer,
  refund_cents      integer,
  refund_id         uuid,
  payment_intent_id text,
  order_number      text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_reason   text := nullif(trim(coalesce(p_reason, '')), '');
  v_order    public.orders%rowtype;
  v_charges  public.order_charges%rowtype;
  v_settings public.settings%rowtype;
  v_pay      public.payments%rowtype;
  v_now      timestamptz := now();
  v_fee      integer := 0;
  v_refund   integer;
  v_refunded bigint;
  v_refund_id uuid;
begin
  if v_reason is not null and length(v_reason) > 2000 then
    raise exception 'customer_cancel_order: reason too long' using errcode = '22023', detail = 'reason';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_customer_id and p.role = 'cliente' and not p.is_blocked) then
    raise exception 'customer_cancel_order: not an active customer' using errcode = '42501';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.customer_id is distinct from p_customer_id then
    raise exception 'customer_cancel_order: order not found' using errcode = '22023', detail = 'order';
  end if;

  if v_order.status = 'cancelled' then
    select c.cancellation_fee_cents into v_fee from public.order_charges c where c.order_id = p_order_id;
    return query select 'already_cancelled'::text, v_fee, null::integer, null::uuid, null::text, v_order.order_number;
    return;
  end if;
  if v_order.status = 'cancellation_review' then
    return query select 'already_in_review'::text, null::integer, null::integer, null::uuid, null::text, v_order.order_number;
    return;
  end if;

  if v_order.status = 'assigned' then
    update public.orders
       set status = 'cancellation_review',
           cancellation_requested_at = v_now, cancellation_requested_by = p_customer_id, cancellation_reason = v_reason
     where id = p_order_id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
    values (p_order_id, 'assigned', 'cancellation_review', p_customer_id, 'customer_app', v_now);
    return query select 'review'::text, null::integer, null::integer, null::uuid, null::text, v_order.order_number;
    return;
  end if;

  if v_order.status <> 'paid' then
    raise exception 'customer_cancel_order: status % cannot be cancelled by the customer', v_order.status
      using errcode = '55000', detail = 'not_cancellable';
  end if;

  select * into v_settings from public.settings;
  select * into v_charges from public.order_charges where order_id = p_order_id for update;
  select * into v_pay from public.payments
   where order_id = p_order_id and status = 'succeeded'
   order by paid_at desc limit 1;
  if not found then
    raise exception 'customer_cancel_order: no succeeded payment' using errcode = '55000', detail = 'no_payment';
  end if;

  if v_now >= v_order.pickup_window_start - make_interval(hours => v_settings.free_cancellation_hours) then
    v_fee := least(public.order_late_cancellation_fee(p_order_id, v_settings.late_cancellation_fee_bp), v_charges.total_cents);
  end if;
  -- What is still refundable: the total minus the fee minus refunds already made or in progress.
  select coalesce(sum(r.amount_cents), 0) into v_refunded from public.refunds r where r.order_id = p_order_id and r.status <> 'failed';
  v_refund := greatest(v_charges.total_cents - v_fee - v_refunded, 0)::integer;

  update public.orders
     set status = 'cancelled', cancelled_at = v_now,
         cancellation_requested_at = v_now, cancellation_requested_by = p_customer_id, cancellation_reason = v_reason,
         cancellation_decided_at = v_now, cancellation_decided_by = null      -- automatic (D33), no admin decision
   where id = p_order_id;
  update public.order_charges set cancellation_fee_cents = v_fee where order_id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, source, created_at)
  values (p_order_id, 'paid', 'cancelled', p_customer_id, 'customer_app', v_now);

  if v_refund > 0 then
    insert into public.refunds (order_id, payment_id, kind, amount_cents, reason, created_by, created_at)
    values (p_order_id, v_pay.id, 'customer_cancellation', v_refund, 'customer_cancellation', p_customer_id, v_now)
    returning id into v_refund_id;
  end if;

  return query select 'cancelled'::text, v_fee, v_refund, v_refund_id, v_pay.stripe_payment_intent_id, v_order.order_number;
end;
$$;

comment on column public.refunds.created_by is
  'Who started the refund: the admin, or the customer for an automatic cancellation refund (kind customer_cancellation). No FK.';

-- ---------------------------------------------------------------------------
-- record_refund_result
-- ---------------------------------------------------------------------------
-- pending → pending (Stripe id only) | succeeded | failed; succeeded / failed are final. Returns true when the row
-- changed. refunded_cents grows only on the transition to succeeded, so a repeated call never counts twice.
create function public.record_refund_result(p_refund_id uuid, p_stripe_refund_id text, p_status public.refund_status)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
begin
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'record_refund_result: refund not found' using errcode = '22023', detail = 'refund';
  end if;
  if p_stripe_refund_id is not null and v_refund.stripe_refund_id is not null and v_refund.stripe_refund_id <> p_stripe_refund_id then
    raise exception 'record_refund_result: another Stripe refund is already linked' using errcode = '55000', detail = 'stripe_id_mismatch';
  end if;
  if v_refund.status <> 'pending' then
    return false;
  end if;

  update public.refunds
     set status = p_status, stripe_refund_id = coalesce(p_stripe_refund_id, stripe_refund_id)
   where id = p_refund_id;
  if p_status = 'succeeded' then
    update public.order_charges set refunded_cents = refunded_cents + v_refund.amount_cents where order_id = v_refund.order_id;
  end if;
  return p_status <> 'pending' or (p_stripe_refund_id is not null and v_refund.stripe_refund_id is null);
end;
$$;

revoke execute on function public.order_late_cancellation_fee(uuid, integer) from public, anon, authenticated;
revoke execute on function public.customer_cancel_order(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.record_refund_result(uuid, text, public.refund_status) from public, anon, authenticated;
grant execute on function public.order_late_cancellation_fee(uuid, integer) to service_role;
grant execute on function public.customer_cancel_order(uuid, uuid, text) to service_role;
grant execute on function public.record_refund_result(uuid, text, public.refund_status) to service_role;
