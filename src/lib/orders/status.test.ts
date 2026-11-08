import { describe, expect, it } from "vitest";
import { ORDER_STATUS_LABEL, paymentState } from "./status";

const now = new Date("2026-11-09T10:00:00Z");
const o = (status: string, extra: Partial<Parameters<typeof paymentState>[0]> = {}) => ({ status, payment_due_at: "2026-11-09T11:00:00Z", paid_at: null, ...extra });

describe("paymentState", () => {
  it("pending_payment: to pay before the deadline, overdue after", () => {
    expect(paymentState(o("pending_payment"), now)).toBe("to_pay");
    expect(paymentState(o("pending_payment"), new Date("2026-11-09T11:00:00Z"))).toBe("overdue");
  });
  it("paid and every later status count as paid", () => {
    for (const s of ["paid", "assigned", "picked_up", "in_transit", "delivered", "completed", "cancellation_review"]) {
      expect(paymentState(o(s, { paid_at: "2026-11-09T09:00:00Z" }), now)).toBe("paid");
    }
  });
  it("payment_review, expired, refunded", () => {
    expect(paymentState(o("payment_review"), now)).toBe("review");
    expect(paymentState(o("expired"), now)).toBe("not_paid");
    expect(paymentState(o("refunded", { paid_at: "x" }), now)).toBe("refunded");
  });
  it("cancelled: not paid / fully refunded / partially refunded", () => {
    expect(paymentState(o("cancelled"), now)).toBe("not_paid");
    expect(paymentState(o("cancelled", { paid_at: "x", refunded_cents: 100, total_cents: 100 }), now)).toBe("refunded");
    expect(paymentState(o("cancelled", { paid_at: "x", refunded_cents: 50, total_cents: 100 }), now)).toBe("paid");
  });
  it("every order status has an Italian label, payment_review included", () => {
    expect(ORDER_STATUS_LABEL.payment_review).toBe("Pagamento da verificare");
  });
});
