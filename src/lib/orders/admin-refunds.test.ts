import { describe, expect, it } from "vitest";
import {
  activeRefundCents,
  canRetryRefund,
  cancellationDecisionSuggestion,
  centsToInput,
  decideCancellationSchema,
  manualRefundSchema,
  REFUND_MSG,
  refundDbError,
  refundFormError,
  type RefundLike,
} from "./admin-refunds";

const ID = "33333333-3333-4333-8333-333333333333";
const H = 3_600_000;
const lines = [
  { line_type: "transport", gross_cents: 12_200 },
  { line_type: "porters", gross_cents: 7_320 },
  { line_type: "storage", gross_cents: 4_270 },
];

describe("forms", () => {
  it("euro amounts → cents without floats; 0 allowed in a decision, not in a manual refund", () => {
    expect(decideCancellationSchema.parse({ orderId: ID, refund: "120,50", carrier: "0" })).toEqual({ orderId: ID, refund: 12_050, carrier: 0 });
    expect(decideCancellationSchema.parse({ orderId: ID, refund: "1.234,5", carrier: "10" })).toMatchObject({ refund: 123_450, carrier: 1_000 });
    expect(decideCancellationSchema.safeParse({ orderId: ID, refund: "-1", carrier: "0" }).success).toBe(false);
    expect(decideCancellationSchema.safeParse({ orderId: ID, refund: "1,234", carrier: "0" }).success).toBe(false);
    expect(manualRefundSchema.safeParse({ orderId: ID, amount: "0", reason: "goodwill" }).success).toBe(false);
    expect(manualRefundSchema.parse({ orderId: ID, amount: "0,01", reason: "claim" })).toEqual({ orderId: ID, amount: 1, reason: "claim" });
  });

  it("only reasons from the list; the first error is readable", () => {
    const r = manualRefundSchema.safeParse({ orderId: ID, amount: "abc", reason: "because" });
    expect(r.success).toBe(false);
    if (!r.success) expect(refundFormError(r.error.issues)).toBe(REFUND_MSG.chooseReason);
    const a = manualRefundSchema.safeParse({ orderId: ID, amount: "abc", reason: "other" });
    if (!a.success) expect(refundFormError(a.error.issues)).toBe(REFUND_MSG.invalidAmount);
  });

  it("centsToInput is the inverse of the parser", () => {
    for (const c of [0, 1, 99, 100, 12_050, 1_952_000]) {
      expect(decideCancellationSchema.parse({ orderId: ID, refund: centsToInput(c), carrier: "0" }).refund).toBe(c);
    }
  });
});

describe("database errors", () => {
  it("map to the admin's messages; unknown → generic", () => {
    expect(refundDbError({ code: "22023", details: "refund_amount" })).toBe(REFUND_MSG.refundTooHigh);
    expect(refundDbError({ code: "22023", details: "carrier_amount" })).toBe(REFUND_MSG.carrierTooHigh);
    expect(refundDbError({ code: "55000", details: "in_progress" })).toBe(REFUND_MSG.inProgress);
    expect(refundDbError({ code: "55000", details: "duplicate_payment" })).toBe(REFUND_MSG.duplicateOnlyRefund);
    expect(refundDbError({ code: "42501" })).toBe(REFUND_MSG.generic);
    expect(refundDbError(null)).toBe(REFUND_MSG.generic);
  });
});

describe("cancellationDecisionSuggestion (D140 — the D137 rule at the time of the request)", () => {
  const base = { pickupWindowStart: new Date("2026-12-01T09:00:00Z"), freeHours: 24, feeBp: 5_000, totalCents: 23_790, refundedCents: 0, lines };

  it("request ≥ 24 h before pickup → everything back", () => {
    expect(cancellationDecisionSuggestion({ ...base, requestedAt: new Date(base.pickupWindowStart.getTime() - 25 * H) }))
      .toEqual({ refundCents: 23_790, feeCents: 0, late: false });
  });

  it("request later → 50 % of everything except storage, rounded half up", () => {
    // (12 200 + 7 320) × 0.5 = 9 760
    expect(cancellationDecisionSuggestion({ ...base, requestedAt: new Date(base.pickupWindowStart.getTime() - 2 * H) }))
      .toEqual({ refundCents: 23_790 - 9_760, feeCents: 9_760, late: true });
  });

  it("refunds already made are subtracted", () => {
    expect(cancellationDecisionSuggestion({ ...base, refundedCents: 790, requestedAt: new Date(base.pickupWindowStart.getTime() - 48 * H) }).refundCents).toBe(23_000);
  });
});

describe("refund rows", () => {
  const r = (over: Partial<RefundLike>): RefundLike => ({ id: "a", amount_cents: 100, status: "pending", stripe_refund_id: null, retry_of: null, ...over });

  it("failed refunds do not count", () => {
    expect(activeRefundCents([r({ amount_cents: 100 }), r({ amount_cents: 50, status: "succeeded" }), r({ amount_cents: 999, status: "failed" })])).toBe(150);
  });

  it("Riprova: pending without a Stripe id, failed without a retry — nothing else", () => {
    expect(canRetryRefund(r({}), [])).toBe(true);
    expect(canRetryRefund(r({ stripe_refund_id: "re_1" }), [])).toBe(false);
    expect(canRetryRefund(r({ status: "succeeded", stripe_refund_id: "re_1" }), [])).toBe(false);
    const failed = r({ id: "f", status: "failed", stripe_refund_id: "re_1" });
    expect(canRetryRefund(failed, [failed])).toBe(true);
    expect(canRetryRefund(failed, [failed, r({ id: "n", retry_of: "f" })])).toBe(false);
  });
});
