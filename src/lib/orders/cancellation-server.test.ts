import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe/server", () => ({ getStripe: () => { throw new Error("no real Stripe in unit tests"); } }));
vi.mock("@/lib/notifications/email", () => ({ sendEmail: vi.fn() }));

const { CANCEL_MSG, cancelOrderForCustomer } = await import("./cancellation-server");
type Deps = Parameters<typeof cancelOrderForCustomer>[0];
type Row = Awaited<ReturnType<Deps["cancelInDb"]>>["data"];

// The money flow of the customer cancellation (D137): the database decides the amounts; Stripe is called only for a
// refund row the database created, with that row's amount; a Stripe error never undoes the cancellation.

const ORDER = "33333333-3333-4333-8333-333333333333";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const REFUND = "44444444-4444-4444-8444-444444444444";

function deps(row: Row, error: { code?: string; details?: string } | null = null, over: Partial<Deps> = {}) {
  const events: string[] = [];
  const d: Deps = {
    cancelInDb: vi.fn(async () => ({ data: row, error })),
    createStripeRefund: vi.fn(async (a) => {
      events.push(`stripe:${a.paymentIntentId}:${a.amountCents}:${a.refundId}`);
      return { id: "re_1", status: "succeeded" };
    }),
    recordRefund: vi.fn(async (id, stripeId, status) => {
      events.push(`record:${id}:${stripeId}:${status}`);
    }),
    notify: vi.fn((kind) => {
      events.push(`notify:${kind}`);
    }),
    log: vi.fn(),
    ...over,
  };
  return { d, events };
}

const cancelledRow = (fee: number, refund: number, refundId: string | null = REFUND): Row => ({
  result: "cancelled", fee_cents: fee, refund_cents: refund, refund_id: refundId, payment_intent_id: "pi_1", order_number: "TG-2026-000001",
});

describe("cancelOrderForCustomer", () => {
  it("passes the session customer and the reason to the database", async () => {
    const { d } = deps(cancelledRow(0, 19_520));
    await cancelOrderForCustomer(d, CUSTOMER, ORDER, "Ho cambiato idea");
    expect(d.cancelInDb).toHaveBeenCalledWith(ORDER, CUSTOMER, "Ho cambiato idea");
  });

  it("cancelled with a refund: Stripe gets exactly the database amount, then the result is recorded, then the e-mail", async () => {
    const { d, events } = deps(cancelledRow(9_760, 9_760));
    const r = await cancelOrderForCustomer(d, CUSTOMER, ORDER, null);
    expect(r).toEqual({ ok: true, kind: "cancelled", feeCents: 9_760, refundCents: 9_760, refund: "succeeded" });
    expect(events).toEqual([`stripe:pi_1:9760:${REFUND}`, `record:${REFUND}:re_1:succeeded`, "notify:cancelled"]);
  });

  it("a pending Stripe refund is recorded as pending", async () => {
    const { d, events } = deps(cancelledRow(0, 100), null, { createStripeRefund: vi.fn(async () => ({ id: "re_2", status: "pending" })) });
    const r = await cancelOrderForCustomer(d, CUSTOMER, ORDER, null);
    expect(r).toMatchObject({ refund: "pending" });
    expect(events).toContain(`record:${REFUND}:re_2:pending`);
  });

  it("a Stripe error keeps the cancellation (refund stays pending for the admin) and still sends the e-mail", async () => {
    const { d, events } = deps(cancelledRow(0, 19_520), null, { createStripeRefund: vi.fn(async () => { throw new Error("card_declined"); }) });
    const r = await cancelOrderForCustomer(d, CUSTOMER, ORDER, null);
    expect(r).toEqual({ ok: true, kind: "cancelled", feeCents: 0, refundCents: 19_520, refund: "pending" });
    expect(d.recordRefund).not.toHaveBeenCalled();
    expect(events).toEqual(["notify:cancelled"]);
    expect(d.log).toHaveBeenCalled();
  });

  it("no refund row (fee = total) → no Stripe call", async () => {
    const { d, events } = deps(cancelledRow(500, 0, null));
    expect(await cancelOrderForCustomer(d, CUSTOMER, ORDER, null)).toMatchObject({ refund: "none", refundCents: 0 });
    expect(events).toEqual(["notify:cancelled"]);
  });

  it("assigned → review: no Stripe, admin + carrier notified", async () => {
    const { d, events } = deps({ result: "review", fee_cents: null, refund_cents: null, refund_id: null, payment_intent_id: null, order_number: "TG-1" });
    expect(await cancelOrderForCustomer(d, CUSTOMER, ORDER, null)).toEqual({ ok: true, kind: "review" });
    expect(events).toEqual(["notify:review"]);
  });

  it("a repeated click: nothing sent again", async () => {
    for (const result of ["already_cancelled", "already_in_review"] as const) {
      const { d, events } = deps({ result, fee_cents: null, refund_cents: null, refund_id: null, payment_intent_id: null, order_number: "TG-1" });
      expect(await cancelOrderForCustomer(d, CUSTOMER, ORDER, null)).toEqual({ ok: true, kind: result });
      expect(events).toEqual([]);
    }
  });

  it("database refusals become Italian messages; nothing else happens", async () => {
    const cases: [{ code: string; details?: string }, string][] = [
      [{ code: "22023", details: "order" }, CANCEL_MSG.notFound],
      [{ code: "55000", details: "not_cancellable" }, CANCEL_MSG.notCancellable],
      [{ code: "42501" }, CANCEL_MSG.generic],
    ];
    for (const [error, message] of cases) {
      const { d, events } = deps(null, error);
      expect(await cancelOrderForCustomer(d, CUSTOMER, ORDER, null)).toEqual({ ok: false, message });
      expect(events).toEqual([]);
    }
  });
});
