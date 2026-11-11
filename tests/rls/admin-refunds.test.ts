import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, localSql, service, type TestUser } from "./helpers";
import { accept, activeCarrier, check, paidOrder, reviewOrder, run, setupJobContext, teardownJobContext, type DbError } from "./job-fixtures";

// Admin money decisions (D140–D142; migration 20261111160000_admin_refunds.sql). On the real database: only the
// service role runs the functions and only for an active admin; amounts are checked under the order lock; a decision
// is made once (repeated and concurrent clicks never add a refund); the carrier's share and admin ids stay hidden
// from customers; audit_log in the same transaction, without free text.

let customer: TestUser;
let admin: TestUser;
let blockedAdmin: TestUser;
let carrier: { user: TestUser; vehicleId: string };

const TOTAL = 19_520;          // job-fixtures payload, one leg
const CARRIER_AMOUNT = 11_800;

type DecideRow = { result: string; refund_id: string | null; refund_cents: number | null; payment_intent_id: string | null; order_number: string };
type ReviewRow = { result: string; refund_id: string | null; refund_cents: number | null; payment_intent_id: string | null; order_id: string; order_number: string };
type RefundRow = { refund_id: string; full_refund: boolean; new_status: string; payment_intent_id: string | null; order_number: string };
type RetryRow = { refund_id: string; amount_cents: number; payment_intent_id: string | null; order_id: string; newly_created: boolean };

const decide = (orderId: string, refund: number, carrierCents: number, adminId = admin.id) =>
  service.rpc("admin_decide_cancellation", { p_order_id: orderId, p_admin_id: adminId, p_refund_cents: refund, p_carrier_cents: carrierCents }).single<DecideRow>();
const resolve = (paymentId: string, action: string) =>
  service.rpc("admin_resolve_payment_review", { p_payment_id: paymentId, p_admin_id: admin.id, p_action: action }).single<ReviewRow>();
const refund = (orderId: string, amount: number, reason = "goodwill") =>
  service.rpc("admin_refund_order", { p_order_id: orderId, p_admin_id: admin.id, p_amount_cents: amount, p_reason_code: reason }).single<RefundRow>();
const retry = (refundId: string) => service.rpc("admin_retry_refund", { p_refund_id: refundId, p_admin_id: admin.id }).single<RetryRow>();

const orderState = (id: string) => check(service.from("orders").select("status, paid_at, cancelled_at, cancellation_decided_at, cancellation_decided_by").eq("id", id).single());
const refundsOf = (id: string) =>
  check(service.from("refunds").select("id, kind, amount_cents, reason, status, created_by, retry_of, payment_id").eq("order_id", id).order("created_at"));
const auditOf = (entityId: string) => check(service.from("audit_log").select("action, actor_id, data").eq("entity_id", entityId));
const history = (id: string) => check(service.from("order_status_history").select("from_status, to_status, changed_by, source").eq("order_id", id).order("id"));

/** paid → assigned → customer asks to cancel → cancellation_review. */
async function inReview(): Promise<string> {
  const orderId = await paidOrder({ hoursAhead: 72 });
  await check(accept(carrier.user, orderId, carrier.vehicleId));
  const { error } = await service.rpc("customer_cancel_order", { p_order_id: orderId, p_customer_id: customer.id, p_reason: null }).single();
  if (error) throw error;
  expect((await orderState(orderId)).status).toBe("cancellation_review");
  return orderId;
}

/** A second successful Checkout for an already paid order (D96 duplicate_payment). */
async function duplicatePayment(orderId: string): Promise<string> {
  const session = `cs_test_${randomUUID()}`;
  const r = localSql(`insert into public.payments (order_id, amount_cents, stripe_checkout_session_id, transfer_group, expires_at)
    select id, ${TOTAL}, '${session}', order_number, now() + interval '1 hour' from public.orders where id = '${orderId}';`);
  if (!r.ok) throw new Error(r.output);
  await run(service.rpc("confirm_order_payment", { p_session_id: session, p_payment_intent_id: `pi_${randomUUID()}`, p_charge_id: `ch_${randomUUID()}`, p_amount_cents: TOTAL, p_currency: "eur" }));
  const pay = await check(service.from("payments").select("id, review_reason").eq("stripe_checkout_session_id", session).single());
  expect(pay.review_reason).toBe("duplicate_payment");
  return pay.id;
}

beforeAll(async () => {
  const ctx = await setupJobContext();
  customer = ctx.customer;
  admin = ctx.admin;
  carrier = await activeCarrier("van_medium", 1200);
  blockedAdmin = await createUser({});
  await run(service.from("profiles").update({ role: "admin", is_blocked: true }).eq("id", blockedAdmin.id));
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("who may call", () => {
  it("anon, customer, carrier and admin sessions cannot execute the functions", async () => {
    const orderId = await paidOrder();
    const id = randomUUID();
    for (const client of [anon, customer.client, carrier.user.client, admin.client]) {
      const calls = await Promise.all([
        client.rpc("admin_decide_cancellation", { p_order_id: orderId, p_admin_id: admin.id, p_refund_cents: 0, p_carrier_cents: 0 }),
        client.rpc("admin_resolve_payment_review", { p_payment_id: id, p_admin_id: admin.id, p_action: "refund" }),
        client.rpc("admin_refund_order", { p_order_id: orderId, p_admin_id: admin.id, p_amount_cents: 100, p_reason_code: "goodwill" }),
        client.rpc("admin_retry_refund", { p_refund_id: id, p_admin_id: admin.id }),
        client.rpc("order_main_payment", { p_order_id: orderId }),
        client.rpc("payment_refundable_cents", { p_payment_id: id }),
      ]);
      for (const r of calls) expect((r.error as DbError)?.code).toBe("42501");
    }
    expect(await refundsOf(orderId)).toEqual([]);
  });

  it("a blocked admin or a customer id as admin is refused", async () => {
    const orderId = await inReview();
    for (const adminId of [blockedAdmin.id, customer.id]) {
      expect((await decide(orderId, 100, 0, adminId)).error).toMatchObject({ code: "42501" });
    }
    expect((await orderState(orderId)).status).toBe("cancellation_review");
  });
});

describe("what sessions read", () => {
  it("the customer reads its refunds without created_by; the decision table only the admin", async () => {
    const orderId = await inReview();
    await check(decide(orderId, 10_000, 3_000));

    expect(await check(customer.client.from("refunds").select("amount_cents, status, kind").eq("order_id", orderId)))
      .toEqual([{ amount_cents: 10_000, status: "pending", kind: "customer_cancellation" }]);
    expect((await customer.client.from("refunds").select("created_by").eq("order_id", orderId)).error).toMatchObject({ code: "42501" });
    expect((await admin.client.from("refunds").select("created_by").eq("order_id", orderId)).error).toMatchObject({ code: "42501" });

    expect(await check(customer.client.from("order_cancellation_decisions").select("*").eq("order_id", orderId))).toEqual([]);
    expect(await check(carrier.user.client.from("order_cancellation_decisions").select("*").eq("order_id", orderId))).toEqual([]);
    expect(await check(admin.client.from("order_cancellation_decisions").select("refund_cents, carrier_cents").eq("order_id", orderId)))
      .toEqual([{ refund_cents: 10_000, carrier_cents: 3_000 }]);
    // The customer's order row does not reveal the admin.
    expect((await check(customer.client.from("orders").select("cancellation_decided_by").eq("id", orderId).single())).cancellation_decided_by).toBeNull();
  });

  it("nobody writes the decision table directly", async () => {
    const orderId = await paidOrder();
    for (const client of [admin.client, service]) {
      const { error } = await client.from("order_cancellation_decisions").insert({ order_id: orderId, refund_cents: 0, carrier_cents: 0 });
      expect((error as DbError)?.code).toBe("42501");
    }
  });
});

describe("admin_decide_cancellation (D140)", () => {
  it("only an order in cancellation_review", async () => {
    const orderId = await paidOrder();
    expect((await decide(orderId, 0, 0)).error).toMatchObject({ code: "55000", details: "not_in_review" });
    expect((await decide(randomUUID(), 0, 0)).error).toMatchObject({ code: "22023", details: "order" });
  });

  it("amounts outside the limits are refused before anything changes", async () => {
    const orderId = await inReview();
    expect((await decide(orderId, TOTAL + 1, 0)).error).toMatchObject({ code: "22023", details: "refund_amount" });
    expect((await decide(orderId, -1, 0)).error).toMatchObject({ code: "22023", details: "refund_amount" });
    expect((await decide(orderId, 0, CARRIER_AMOUNT + 1)).error).toMatchObject({ code: "22023", details: "carrier_amount" });
    expect((await decide(orderId, 0, -1)).error).toMatchObject({ code: "22023", details: "carrier_amount" });
    expect((await orderState(orderId)).status).toBe("cancellation_review");
    expect(await refundsOf(orderId)).toEqual([]);
  });

  it("cancels, records the fee, the decision, a pending refund, history and audit — once", async () => {
    const orderId = await inReview();
    const row = await check(decide(orderId, 12_000, CARRIER_AMOUNT));
    expect(row).toMatchObject({ result: "cancelled", refund_cents: 12_000 });
    expect(row.payment_intent_id).toMatch(/^pi_/);

    const o = await orderState(orderId);
    expect(o).toMatchObject({ status: "cancelled", cancellation_decided_by: null });
    expect(o.cancelled_at).not.toBeNull();
    expect(o.cancellation_decided_at).not.toBeNull();
    expect(await check(service.from("order_charges").select("cancellation_fee_cents, refunded_cents").eq("order_id", orderId).single()))
      .toEqual({ cancellation_fee_cents: TOTAL - 12_000, refunded_cents: 0 });
    expect(await refundsOf(orderId)).toMatchObject([{ id: row.refund_id, kind: "customer_cancellation", amount_cents: 12_000, reason: "cancellation_decision", status: "pending", created_by: admin.id }]);
    expect((await history(orderId)).at(-1)).toEqual({ from_status: "cancellation_review", to_status: "cancelled", changed_by: admin.id, source: "admin_panel" });
    expect(await auditOf(orderId)).toContainEqual({
      action: "order.cancellation_decided", actor_id: admin.id,
      data: { refund_cents: 12_000, carrier_cents: CARRIER_AMOUNT, refund_id: row.refund_id },
    });

    // Second click: nothing new.
    expect(await check(decide(orderId, 5_000, 0))).toMatchObject({ result: "already_decided", refund_cents: 12_000, refund_id: null });
    expect(await refundsOf(orderId)).toHaveLength(1);
  });

  it("refund 0 → cancelled without a refund row, the whole total kept", async () => {
    const orderId = await inReview();
    expect(await check(decide(orderId, 0, 0))).toMatchObject({ result: "cancelled", refund_id: null });
    expect(await refundsOf(orderId)).toEqual([]);
    expect((await check(service.from("order_charges").select("cancellation_fee_cents").eq("order_id", orderId).single())).cancellation_fee_cents).toBe(TOTAL);
  });

  it("two concurrent decisions: one cancels, the other sees it decided, one refund", async () => {
    const orderId = await inReview();
    const [a, b] = await Promise.all([decide(orderId, 9_000, 0), decide(orderId, 9_000, 0)]);
    expect([a.data?.result, b.data?.result].sort()).toEqual(["already_decided", "cancelled"]);
    expect(await refundsOf(orderId)).toHaveLength(1);
  });
});

describe("admin_resolve_payment_review (D141)", () => {
  it("mark_paid: payment_review → paid with the Stripe payment time; the job becomes available", async () => {
    const { orderId, paymentId } = await reviewOrder();
    expect((await orderState(orderId)).status).toBe("payment_review");
    expect(await check(resolve(paymentId, "mark_paid"))).toMatchObject({ result: "paid", refund_id: null, order_id: orderId });
    const o = await orderState(orderId);
    expect(o.status).toBe("paid");
    expect(o.paid_at).not.toBeNull();
    expect(await check(service.from("payments").select("review_outcome").eq("id", paymentId).single())).toEqual({ review_outcome: "accepted" });
    expect((await history(orderId)).at(-1)).toEqual({ from_status: "payment_review", to_status: "paid", changed_by: admin.id, source: "admin_panel" });
    expect(await auditOf(paymentId)).toContainEqual({ action: "payment.review_accepted", actor_id: admin.id, data: { order_id: orderId, review_reason: "amount_mismatch" } });

    // Repeated / the other action afterwards → already resolved, nothing else.
    expect(await check(resolve(paymentId, "refund"))).toMatchObject({ result: "already_resolved" });
    expect(await refundsOf(orderId)).toEqual([]);
    // The accepted payment is now the order's payment: a manual refund works on it.
    expect(await check(refund(orderId, 500))).toMatchObject({ full_refund: false, new_status: "paid" });
  });

  it("refund: the whole received amount, order → refunded", async () => {
    const { orderId, paymentId, receivedCents } = await reviewOrder({ receivedDelta: 250 });
    const row = await check(resolve(paymentId, "refund"));
    expect(row).toMatchObject({ result: "refunded", refund_cents: receivedCents });
    expect((await orderState(orderId)).status).toBe("refunded");
    expect(await refundsOf(orderId)).toMatchObject([{ id: row.refund_id, kind: "admin", amount_cents: receivedCents, reason: "payment_review", status: "pending" }]);
    expect(await check(service.from("payments").select("review_outcome").eq("id", paymentId).single())).toEqual({ review_outcome: "refunded" });
  });

  it("duplicate payment: only refund, the order stays paid, the first payment untouched", async () => {
    const orderId = await paidOrder();
    const dup = await duplicatePayment(orderId);
    expect((await resolve(dup, "mark_paid")).error).toMatchObject({ code: "55000", details: "duplicate_payment" });

    const row = await check(resolve(dup, "refund"));
    expect(row).toMatchObject({ result: "refunded", refund_cents: TOTAL });
    expect((await orderState(orderId)).status).toBe("paid");
    const refunds = await refundsOf(orderId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].payment_id).toBe(dup);
    // The original payment is still fully refundable.
    expect(await check(refund(orderId, TOTAL))).toMatchObject({ full_refund: true, new_status: "refunded" });
  });

  it("a payment without review, an unknown action, two concurrent clicks", async () => {
    const orderId = await paidOrder();
    const main = await check(service.from("payments").select("id").eq("order_id", orderId).single());
    expect((await resolve(main.id, "refund")).error).toMatchObject({ code: "22023", details: "payment" });

    const { orderId: o2, paymentId } = await reviewOrder();
    expect((await resolve(paymentId, "accept")).error).toMatchObject({ code: "22023", details: "action" });
    const [a, b] = await Promise.all([resolve(paymentId, "refund"), resolve(paymentId, "refund")]);
    expect([a.data?.result, b.data?.result].sort()).toEqual(["already_resolved", "refunded"]);
    expect(await refundsOf(o2)).toHaveLength(1);
  });
});

describe("admin_refund_order (D142)", () => {
  it("reason from the list, amount 1 … refundable", async () => {
    const orderId = await paidOrder();
    expect((await refund(orderId, 100, "because")).error).toMatchObject({ code: "22023", details: "reason" });
    expect((await refund(orderId, 0)).error).toMatchObject({ code: "22023", details: "amount" });
    expect((await refund(orderId, TOTAL + 1)).error).toMatchObject({ code: "22023", details: "amount" });
    expect(await refundsOf(orderId)).toEqual([]);
  });

  it("partial keeps the status; the rest in full → refunded; nothing more after that", async () => {
    const orderId = await paidOrder();
    const a = await check(refund(orderId, 4_000, "service_issue"));
    expect(a).toMatchObject({ full_refund: false, new_status: "paid" });
    expect((await refund(orderId, TOTAL - 4_000 + 1)).error).toMatchObject({ code: "22023", details: "amount" });

    const b = await check(refund(orderId, TOTAL - 4_000, "claim"));
    expect(b).toMatchObject({ full_refund: true, new_status: "refunded" });
    expect((await orderState(orderId)).status).toBe("refunded");
    expect((await refund(orderId, 1)).error).toMatchObject({ code: "55000", details: "not_refundable" });

    expect((await refundsOf(orderId)).map((r) => [r.kind, r.amount_cents, r.reason])).toEqual([["admin", 4_000, "service_issue"], ["admin", TOTAL - 4_000, "claim"]]);
    expect(await auditOf(orderId)).toContainEqual({
      action: "order.refunded", actor_id: admin.id,
      data: { refund_id: b.refund_id, amount_cents: TOTAL - 4_000, reason: "claim", full: true, from_status: "paid", to_status: "refunded" },
    });
  });

  it("a job in progress: partial yes, full only after unassigning", async () => {
    const orderId = await paidOrder();
    await check(accept(carrier.user, orderId, carrier.vehicleId));
    expect((await refund(orderId, TOTAL)).error).toMatchObject({ code: "55000", details: "in_progress" });
    expect(await check(refund(orderId, 1_000))).toMatchObject({ full_refund: false, new_status: "assigned" });
  });

  it("a cancelled order (late fee) can get the fee back and stays cancelled", async () => {
    const orderId = await paidOrder({ hoursAhead: 5 });     // < 24 h → fee (D137)
    const c = await check(service.rpc("customer_cancel_order", { p_order_id: orderId, p_customer_id: customer.id, p_reason: null }).single<{ fee_cents: number }>());
    expect(c.fee_cents).toBeGreaterThan(0);
    expect(await check(refund(orderId, c.fee_cents, "goodwill"))).toMatchObject({ full_refund: true, new_status: "cancelled" });
    expect((await orderState(orderId)).status).toBe("cancelled");
  });

  it("orders without money are refused", async () => {
    const { orderId } = await reviewOrder();
    expect((await refund(orderId, 100)).error).toMatchObject({ code: "55000", details: "not_refundable" });
  });
});

describe("admin_retry_refund (D142)", () => {
  it("pending → the same row; failed → one new row; succeeded → refused", async () => {
    const orderId = await paidOrder();
    const first = await check(refund(orderId, 3_000));
    expect(await check(retry(first.refund_id))).toMatchObject({ refund_id: first.refund_id, amount_cents: 3_000, newly_created: false });

    await run(service.rpc("record_refund_result", { p_refund_id: first.refund_id, p_stripe_refund_id: `re_${randomUUID()}`, p_status: "failed" }));
    const [a, b] = await Promise.all([retry(first.refund_id), retry(first.refund_id)]);
    const created = [a.data, b.data].filter((r) => r?.newly_created);
    expect(created).toHaveLength(1);
    expect(a.data?.refund_id).toBe(b.data?.refund_id);
    const second = a.data!.refund_id;
    expect(await refundsOf(orderId)).toMatchObject([
      { id: first.refund_id, status: "failed", retry_of: null },
      { id: second, status: "pending", retry_of: first.refund_id, amount_cents: 3_000, kind: "admin", reason: "goodwill" },
    ]);
    expect(await auditOf(second)).toContainEqual({ action: "refund.retried", actor_id: admin.id, data: { order_id: orderId, failed_refund_id: first.refund_id, amount_cents: 3_000 } });

    await run(service.rpc("record_refund_result", { p_refund_id: second, p_stripe_refund_id: `re_${randomUUID()}`, p_status: "succeeded" }));
    expect((await retry(second)).error).toMatchObject({ code: "55000", details: "already_succeeded" });
    expect((await check(service.from("order_charges").select("refunded_cents").eq("order_id", orderId).single())).refunded_cents).toBe(3_000);
    // retry_of cannot be changed afterwards.
    expect((await service.from("refunds").update({ retry_of: null }).eq("id", second)).error).not.toBeNull();
  });
});
