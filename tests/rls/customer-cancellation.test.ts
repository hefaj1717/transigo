import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { lateCancellationFeeCents } from "@/lib/orders/cancellation";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";
import { accept, activeCarrier, check, history, paidOrder, run, setupJobContext, teardownJobContext, type DbError } from "./job-fixtures";

// Customer cancellation of a paid order (D33, D38, D137; migration 20261111140000_customer_cancellation.sql).
// Checked on the real database: only the service role runs the functions; the order must belong to an active
// customer; paid → cancelled with the fee computed by the database (same numbers as the TypeScript preview);
// assigned → cancellation_review; nothing else; repeated and concurrent clicks never create a second refund;
// a cancellation racing with accept_job ends in exactly one consistent state; record_refund_result counts once.

let customer: TestUser;
let otherCustomer: TestUser;
let admin: TestUser;
let carrier: { user: TestUser; vehicleId: string };

type CancelRow = { result: string; fee_cents: number | null; refund_cents: number | null; refund_id: string | null; payment_intent_id: string | null; order_number: string };

const cancel = (orderId: string, customerId = customer.id, reason: string | null = null) =>
  service.rpc("customer_cancel_order", { p_order_id: orderId, p_customer_id: customerId, p_reason: reason }).single<CancelRow>();
const cancelled = async (orderId: string, customerId = customer.id, reason: string | null = null) => check(cancel(orderId, customerId, reason));
const refundsOf = (orderId: string) => check(service.from("refunds").select("id, kind, amount_cents, status, stripe_refund_id, created_by").eq("order_id", orderId));
const charges = (orderId: string) => check(service.from("order_charges").select("total_cents, refunded_cents, cancellation_fee_cents").eq("order_id", orderId).single());
const orderState = (orderId: string) =>
  check(service.from("orders").select("status, carrier_id, cancelled_at, cancellation_requested_at, cancellation_requested_by, cancellation_reason, cancellation_decided_at").eq("id", orderId).single());
const lines = (orderId: string) => check(service.from("order_lines").select("line_type, gross_cents").eq("order_id", orderId));

beforeAll(async () => {
  const ctx = await setupJobContext();
  customer = ctx.customer;
  admin = ctx.admin;
  otherCustomer = await createUser({});
  await run(service.from("customers").insert({ profile_id: otherCustomer.id, customer_type: "private" }));
  carrier = await activeCarrier("van_medium", 1200);
  const settings = await check(service.from("settings").select("free_cancellation_hours, late_cancellation_fee_bp").single());
  // D137 start values — the tests below assume them.
  expect(settings).toEqual({ free_cancellation_hours: 24, late_cancellation_fee_bp: 5000 });
});

afterAll(async () => {
  await teardownJobContext();
  // Accounts with paid orders cannot be deleted (FK restrict, D77) — on purpose; the local database is reset before
  // every run (D64), as in carrier-jobs.test.ts.
  await deleteCreatedUsers().catch(() => undefined);
});

describe("who may call", () => {
  it("anon, customer, carrier and admin sessions cannot execute the functions (service role only)", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    for (const client of [anon, customer.client, carrier.user.client, admin.client]) {
      const a = await client.rpc("customer_cancel_order", { p_order_id: orderId, p_customer_id: customer.id, p_reason: null });
      const b = await client.rpc("record_refund_result", { p_refund_id: randomUUID(), p_stripe_refund_id: null, p_status: "succeeded" });
      const c = await client.rpc("order_late_cancellation_fee", { p_order_id: orderId, p_fee_bp: 5000 });
      for (const r of [a, b, c]) expect((r.error as DbError)?.code).toBe("42501");
    }
    expect((await orderState(orderId)).status).toBe("paid");
  });

  it("another customer's order is 'not found'; a blocked customer is refused", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    const { error } = await cancel(orderId, otherCustomer.id);
    expect(error).toMatchObject({ code: "22023", details: "order" });

    await run(service.from("profiles").update({ is_blocked: true }).eq("id", customer.id));
    try {
      expect((await cancel(orderId)).error).toMatchObject({ code: "42501" });
    } finally {
      await run(service.from("profiles").update({ is_blocked: false }).eq("id", customer.id));
    }
    expect((await orderState(orderId)).status).toBe("paid");
  });

  it("a reason longer than 2000 characters is refused before anything changes", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    expect((await cancel(orderId, customer.id, "x".repeat(2001))).error).toMatchObject({ code: "22023", details: "reason" });
    expect((await orderState(orderId)).status).toBe("paid");
  });
});

describe("paid → cancelled", () => {
  it("≥ 24 h before pickup: free, full refund pending, history from the customer app", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    const r = await cancelled(orderId, customer.id, "  Ho cambiato idea  ");
    expect(r).toMatchObject({ result: "cancelled", fee_cents: 0, refund_cents: 19_520 });
    expect(r.payment_intent_id).toMatch(/^pi_/);

    const o = await orderState(orderId);
    expect(o).toMatchObject({ status: "cancelled", carrier_id: null, cancellation_requested_by: customer.id, cancellation_reason: "Ho cambiato idea" });
    expect(o.cancelled_at).not.toBeNull();
    expect(o.cancellation_decided_at).not.toBeNull();
    expect(await charges(orderId)).toEqual({ total_cents: 19_520, refunded_cents: 0, cancellation_fee_cents: 0 });
    expect(await refundsOf(orderId)).toEqual([
      { id: r.refund_id, kind: "customer_cancellation", amount_cents: 19_520, status: "pending", stripe_refund_id: null, created_by: customer.id },
    ]);
    expect((await history(orderId)).at(-1)).toEqual({ from_status: "paid", to_status: "cancelled", changed_by: customer.id, source: "customer_app" });
  });

  it("< 24 h before pickup: 50 % of transport + porters, the same amount as the TypeScript preview", async () => {
    const orderId = await paidOrder({ hoursAhead: 10 });
    const expectedFee = lateCancellationFeeCents(await lines(orderId), 5000);
    const r = await cancelled(orderId);
    expect(r).toMatchObject({ result: "cancelled", fee_cents: expectedFee, refund_cents: 19_520 - expectedFee });
    expect(expectedFee).toBe(9_760);
    expect((await charges(orderId)).cancellation_fee_cents).toBe(9_760);
  });

  it("late with storage: storage refunded in full (D38)", async () => {
    const orderId = await paidOrder({ hoursAhead: 10, storage: true });
    const r = await cancelled(orderId);
    expect(r).toMatchObject({ fee_cents: 19_520, refund_cents: 43_310 - 19_520 });
  });

  it("order_late_cancellation_fee = lateCancellationFeeCents for every rate (rounding half up)", async () => {
    const orderId = await paidOrder({ hoursAhead: 72, storage: true });
    const ls = await lines(orderId);
    for (const bp of [0, 1, 2, 3333, 5000, 6667, 9999, 10_000]) {
      const sql = await check(service.rpc("order_late_cancellation_fee", { p_order_id: orderId, p_fee_bp: bp }));
      expect(sql, `bp ${bp}`).toBe(lateCancellationFeeCents(ls, bp));
    }
  });

  it("a repeated click returns the cancellation as it is, without a second refund", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    await cancelled(orderId);
    const again = await cancelled(orderId);
    expect(again).toMatchObject({ result: "already_cancelled", fee_cents: 0, refund_id: null });
    expect(await refundsOf(orderId)).toHaveLength(1);
  });

  it("two concurrent cancellations: one cancels, the other sees it — one refund only", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    const results = await Promise.all([cancelled(orderId), cancelled(orderId)]);
    expect(results.map((r) => r.result).sort()).toEqual(["already_cancelled", "cancelled"]);
    expect(await refundsOf(orderId)).toHaveLength(1);
    expect((await history(orderId)).filter((h) => h.to_status === "cancelled")).toHaveLength(1);
  });

  it("a cancelled order disappears from the carrier's list and cannot be accepted", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    await cancelled(orderId);
    const { error } = await accept(carrier.user, orderId, carrier.vehicleId);
    expect(error).not.toBeNull();
    expect((await orderState(orderId)).status).toBe("cancelled");
  });
});

describe("assigned → cancellation_review", () => {
  it("the request waits for the admin; no fee, no refund; the carrier stays on the order", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    await check(accept(carrier.user, orderId, carrier.vehicleId));
    const r = await cancelled(orderId, customer.id, "Trasloco rimandato");
    expect(r).toMatchObject({ result: "review", fee_cents: null, refund_cents: null, refund_id: null });
    expect(await orderState(orderId)).toMatchObject({ status: "cancellation_review", carrier_id: carrier.user.id, cancellation_reason: "Trasloco rimandato", cancelled_at: null, cancellation_decided_at: null });
    expect(await refundsOf(orderId)).toEqual([]);
    expect((await history(orderId)).at(-1)).toEqual({ from_status: "assigned", to_status: "cancellation_review", changed_by: customer.id, source: "customer_app" });
    expect(await cancelled(orderId)).toMatchObject({ result: "already_in_review" });
  });

  it("a cancellation racing with accept_job ends in exactly one consistent state", async () => {
    for (let i = 0; i < 3; i++) {
      const orderId = await paidOrder({ hoursAhead: 72 });
      const [c, a] = await Promise.all([cancel(orderId), accept(carrier.user, orderId, carrier.vehicleId)]);
      expect(c.error).toBeNull();
      const o = await orderState(orderId);
      if (c.data?.result === "cancelled") {
        expect(a.error).not.toBeNull();
        expect(o).toMatchObject({ status: "cancelled", carrier_id: null });
        expect(await refundsOf(orderId)).toHaveLength(1);
      } else {
        expect(c.data?.result).toBe("review");
        expect(a.error).toBeNull();
        expect(o).toMatchObject({ status: "cancellation_review", carrier_id: carrier.user.id });
        expect(await refundsOf(orderId)).toEqual([]);
      }
    }
  });
});

describe("statuses the customer cannot cancel", () => {
  it("picked_up (and later) is refused with not_cancellable", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    await check(accept(carrier.user, orderId, carrier.vehicleId));
    await check(service.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: admin.id, p_to_status: "picked_up", p_note: null }));
    expect((await cancel(orderId)).error).toMatchObject({ code: "55000", details: "not_cancellable" });
    expect((await orderState(orderId)).status).toBe("picked_up");
  });
});

describe("record_refund_result", () => {
  it("succeeded adds the amount to refunded_cents exactly once; then the row is final", async () => {
    const orderId = await paidOrder({ hoursAhead: 10 });
    const r = await cancelled(orderId);
    const record = (stripeId: string | null, status: string) =>
      check(service.rpc("record_refund_result", { p_refund_id: r.refund_id, p_stripe_refund_id: stripeId, p_status: status }));

    expect(await record("re_test_1", "pending")).toBe(true);
    expect(await record("re_test_1", "pending")).toBe(false);
    expect(await record("re_test_1", "succeeded")).toBe(true);
    expect(await record("re_test_1", "succeeded")).toBe(false);
    expect(await record("re_test_1", "failed")).toBe(false);
    expect(await charges(orderId)).toMatchObject({ refunded_cents: 9_760, cancellation_fee_cents: 9_760 });
    expect((await refundsOf(orderId))[0]).toMatchObject({ status: "succeeded", stripe_refund_id: "re_test_1" });

    const other = await service.rpc("record_refund_result", { p_refund_id: r.refund_id, p_stripe_refund_id: "re_test_2", p_status: "succeeded" });
    expect(other.error).toMatchObject({ code: "55000", details: "stripe_id_mismatch" });
  });

  it("failed is final and does not count", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    const r = await cancelled(orderId);
    expect(await check(service.rpc("record_refund_result", { p_refund_id: r.refund_id, p_stripe_refund_id: "re_fail", p_status: "failed" }))).toBe(true);
    expect(await check(service.rpc("record_refund_result", { p_refund_id: r.refund_id, p_stripe_refund_id: "re_fail", p_status: "succeeded" }))).toBe(false);
    expect((await charges(orderId)).refunded_cents).toBe(0);
  });

  it("an unknown refund is refused", async () => {
    const { error } = await service.rpc("record_refund_result", { p_refund_id: randomUUID(), p_stripe_refund_id: null, p_status: "succeeded" });
    expect(error).toMatchObject({ code: "22023", details: "refund" });
  });
});

describe("what the customer sees with their own session", () => {
  it("their cancelled order, its refund and the fee — never another customer's refund", async () => {
    const orderId = await paidOrder({ hoursAhead: 10 });
    await cancelled(orderId);
    const own = await check(customer.client.from("refunds").select("amount_cents, status").eq("order_id", orderId));
    expect(own).toEqual([{ amount_cents: 9_760, status: "pending" }]);
    const o = await check(customer.client.from("orders").select("status").eq("id", orderId).single());
    expect(o.status).toBe("cancelled");
    const c = await check(customer.client.from("order_charges").select("cancellation_fee_cents").eq("order_id", orderId).single());
    expect(c.cancellation_fee_cents).toBe(9_760);
    expect(await check(otherCustomer.client.from("refunds").select("id").eq("order_id", orderId))).toEqual([]);
  });
});
