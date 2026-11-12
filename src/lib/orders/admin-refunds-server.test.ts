import { describe, expect, it, vi } from "vitest";
import type { AdminDeps } from "@/lib/admin/deps";

vi.mock("@/lib/stripe/server", () => ({ getStripe: () => { throw new Error("no real Stripe in unit tests"); } }));
const mail = vi.hoisted(() => ({ sendOrderCancelledEmail: vi.fn(async () => {}) }));
vi.mock("./cancellation-server", () => mail);

const { decideCancellation, refundOrder, resolvePaymentReview, retryRefund } = await import("./admin-refunds-server");
const { REFUND_MSG } = await import("./admin-refunds");
type Io = NonNullable<Parameters<typeof decideCancellation>[2]>;

// The admin money flow (D140–D142): the database decides; Stripe is called only for the refund row the database
// returned, with that row's id as the idempotency key and its amount; a Stripe error never undoes the decision; the
// admin id is the session's.

const ADMIN = "11111111-1111-4111-8111-111111111111";
const ORDER = "33333333-3333-4333-8333-333333333333";
const REFUND = "44444444-4444-4444-8444-444444444444";
const PAYMENT = "55555555-5555-4555-8555-555555555555";

function setup(row: unknown, error: { code?: string; details?: string } | null = null, stripe: Partial<Io> = {}) {
  const events: string[] = [];
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    events.push(`rpc:${name}:${JSON.stringify(args)}`);
    return { single: async () => ({ data: row, error }) };
  });
  const deps = { admin: { userId: ADMIN, email: "a@example.com" }, serviceDb: { rpc }, appUrl: "https://x" } as unknown as AdminDeps;
  const io: Io = {
    createStripeRefund: vi.fn(async (r) => {
      events.push(`stripe:${r.refundId}:${r.paymentIntentId}:${r.amountCents}`);
      return { id: "re_1", status: "succeeded" };
    }),
    recordRefund: vi.fn(async (id, sid, status) => {
      events.push(`record:${id}:${sid}:${status}`);
    }),
    ...stripe,
  };
  mail.sendOrderCancelledEmail.mockClear();
  return { deps, io, events };
}

describe("decideCancellation", () => {
  it("database → Stripe with the row's amount → record → customer e-mail", async () => {
    const { deps, io, events } = setup({ result: "cancelled", refund_id: REFUND, refund_cents: 12_050, payment_intent_id: "pi_1", order_number: "TG-1" });
    const r = await decideCancellation(deps, { orderId: ORDER, refund: "120,50", carrier: "30", adminId: "evil" }, io);
    expect(r).toEqual({ ok: true, message: REFUND_MSG.decided(12_050) });
    expect(events).toEqual([
      `rpc:admin_decide_cancellation:${JSON.stringify({ p_order_id: ORDER, p_admin_id: ADMIN, p_refund_cents: 12_050, p_carrier_cents: 3_000 })}`,
      `stripe:${REFUND}:pi_1:12050`,
      `record:${REFUND}:re_1:succeeded`,
    ]);
    expect(mail.sendOrderCancelledEmail).toHaveBeenCalledTimes(1);
  });

  it("refund 0 → no Stripe call, e-mail still sent", async () => {
    const { deps, io } = setup({ result: "cancelled", refund_id: null, refund_cents: 0, payment_intent_id: "pi_1", order_number: "TG-1" });
    expect(await decideCancellation(deps, { orderId: ORDER, refund: "0", carrier: "0" }, io)).toEqual({ ok: true, message: REFUND_MSG.decided(0) });
    expect(io.createStripeRefund).not.toHaveBeenCalled();
    expect(mail.sendOrderCancelledEmail).toHaveBeenCalledTimes(1);
  });

  it("a Stripe error keeps the decision (row pending) and tells the admin", async () => {
    const { deps, io } = setup(
      { result: "cancelled", refund_id: REFUND, refund_cents: 100, payment_intent_id: "pi_1", order_number: "TG-1" },
      null,
      { createStripeRefund: vi.fn(async () => { throw new Error("stripe down"); }) },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await decideCancellation(deps, { orderId: ORDER, refund: "1", carrier: "0" }, io);
    expect(r).toEqual({ ok: true, message: REFUND_MSG.decided(100) + REFUND_MSG.stripePending });
    expect(io.recordRefund).not.toHaveBeenCalled();
  });

  it("invalid amount → nothing reaches the database; database refusal → message, no Stripe", async () => {
    const a = setup(null);
    expect(await decideCancellation(a.deps, { orderId: ORDER, refund: "dieci", carrier: "0" }, a.io)).toEqual({ ok: false, error: REFUND_MSG.invalidAmount });
    expect(a.events).toEqual([]);

    const b = setup(null, { code: "22023", details: "carrier_amount" });
    expect(await decideCancellation(b.deps, { orderId: ORDER, refund: "1", carrier: "999" }, b.io)).toEqual({ ok: false, error: REFUND_MSG.carrierTooHigh });
    expect(b.io.createStripeRefund).not.toHaveBeenCalled();

    const c = setup({ result: "already_decided", refund_id: null, refund_cents: 5, payment_intent_id: null, order_number: "TG-1" });
    expect(await decideCancellation(c.deps, { orderId: ORDER, refund: "1", carrier: "0" }, c.io)).toEqual({ ok: false, error: REFUND_MSG.alreadyDecided });
    expect(c.io.createStripeRefund).not.toHaveBeenCalled();
    expect(mail.sendOrderCancelledEmail).not.toHaveBeenCalled();
  });
});

describe("resolvePaymentReview", () => {
  it("mark_paid → no Stripe", async () => {
    const { deps, io } = setup({ result: "paid", refund_id: null, refund_cents: null, payment_intent_id: "pi_1", order_id: ORDER, order_number: "TG-1" });
    expect(await resolvePaymentReview(deps, { paymentId: PAYMENT, action: "mark_paid" }, io)).toEqual({ ok: true, message: REFUND_MSG.markedPaid });
    expect(io.createStripeRefund).not.toHaveBeenCalled();
  });

  it("refund → Stripe for the returned row; a pending Stripe answer is reported", async () => {
    const { deps, io, events } = setup(
      { result: "refunded", refund_id: REFUND, refund_cents: 19_520, payment_intent_id: "pi_2", order_id: ORDER, order_number: "TG-1" },
      null,
      { createStripeRefund: vi.fn(async (r) => ({ id: `re_${r.amountCents}`, status: "pending" })) },
    );
    expect(await resolvePaymentReview(deps, { paymentId: PAYMENT, action: "refund" }, io)).toEqual({ ok: true, message: REFUND_MSG.reviewRefunded + REFUND_MSG.stripePending });
    expect(io.recordRefund).toHaveBeenCalledWith(REFUND, "re_19520", "pending");
    expect(events[0]).toContain(`"p_admin_id":"${ADMIN}"`);
  });

  it("a storage chain (D153): one Stripe refund per row the database wrote, with its amount and order", async () => {
    const { deps, io, events } = setup({ result: "refunded", refund_id: "r1", refund_cents: 19_520, payment_intent_id: "pi_3", order_id: ORDER, order_number: "TG-1", refund_ids: ["r1", "r2"] });
    const rows = [{ id: "r2", order_id: "o2", amount_cents: 7_320 }, { id: "r1", order_id: "o1", amount_cents: 12_200 }];
    const inFn = vi.fn(async () => ({ data: rows, error: null }));
    (deps.serviceDb as unknown as { from: unknown }).from = vi.fn(() => ({ select: () => ({ in: inFn }) }));
    expect(await resolvePaymentReview(deps, { paymentId: PAYMENT, action: "refund" }, io)).toEqual({ ok: true, message: REFUND_MSG.reviewRefunded });
    expect(events.slice(1)).toEqual(["stripe:r1:pi_3:12200", "record:r1:re_1:succeeded", "stripe:r2:pi_3:7320", "record:r2:re_1:succeeded"]);
  });

  it("overpaid chain → a clear message, nothing sent to Stripe", async () => {
    const { deps, io } = setup(null, { code: "55000", details: "overpaid_chain" });
    expect(await resolvePaymentReview(deps, { paymentId: PAYMENT, action: "refund" }, io)).toEqual({ ok: false, error: REFUND_MSG.overpaidChain });
    expect(io.createStripeRefund).not.toHaveBeenCalled();
  });

  it("an unknown action never reaches the database", async () => {
    const { deps, io, events } = setup(null);
    expect((await resolvePaymentReview(deps, { paymentId: PAYMENT, action: "accept" }, io)).ok).toBe(false);
    expect(events).toEqual([]);
  });
});

describe("refundOrder / retryRefund", () => {
  it("manual refund: Stripe with the typed amount after the database accepted it", async () => {
    const { deps, io, events } = setup({ refund_id: REFUND, full_refund: true, new_status: "refunded", payment_intent_id: "pi_1", order_number: "TG-1" });
    expect(await refundOrder(deps, { orderId: ORDER, amount: "195,20", reason: "claim" }, io)).toEqual({ ok: true, message: REFUND_MSG.refunded(true) });
    expect(events.slice(1)).toEqual([`stripe:${REFUND}:pi_1:19520`, `record:${REFUND}:re_1:succeeded`]);
  });

  it("retry: Stripe again for the row the database returned (same id = same idempotency key)", async () => {
    const { deps, io, events } = setup({ refund_id: REFUND, amount_cents: 300, payment_intent_id: "pi_1", order_id: ORDER, newly_created: false });
    expect(await retryRefund(deps, { refundId: REFUND }, io)).toEqual({ ok: true, message: REFUND_MSG.retried });
    expect(events.slice(1)).toEqual([`stripe:${REFUND}:pi_1:300`, `record:${REFUND}:re_1:succeeded`]);
  });

  it("Stripe says failed → recorded as failed, the admin sees it", async () => {
    const { deps, io } = setup(
      { refund_id: REFUND, amount_cents: 300, payment_intent_id: "pi_1", order_id: ORDER, newly_created: true },
      null,
      { createStripeRefund: vi.fn(async () => ({ id: "re_x", status: "failed" })) },
    );
    expect(await retryRefund(deps, { refundId: REFUND }, io)).toEqual({ ok: true, message: REFUND_MSG.retried + REFUND_MSG.stripeFailed });
    expect(io.recordRefund).toHaveBeenCalledWith(REFUND, "re_x", "failed");
  });
});
