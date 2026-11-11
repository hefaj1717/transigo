import { describe, expect, it } from "vitest";
import { creditNoteDueFor, INVOICE_TRIGGER, invoiceDueFor, type PaymentFacts } from "./trigger";

const pay = (o: Partial<PaymentFacts> = {}): PaymentFacts => ({ purpose: "order", status: "succeeded", review_reason: null, review_outcome: null, ...o });

describe("invoiceDueFor (D2, D147)", () => {
  it("the moment is the confirmed payment", () => {
    expect(INVOICE_TRIGGER).toBe("payment_confirmed");
  });

  it("a succeeded order payment, whatever the order status", () => {
    for (const status of ["paid", "assigned", "delivered", "completed", "cancelled", "refunded", "cancellation_review"]) {
      expect(invoiceDueFor(pay(), { status })).toBe(true);
    }
  });

  it("not before success; not while in review; accepted in review → yes; refunded in review → never", () => {
    for (const status of ["pending", "expired", "failed"] as const) expect(invoiceDueFor(pay({ status }), { status: "paid" })).toBe(false);
    expect(invoiceDueFor(pay({ review_reason: "amount_mismatch" }), { status: "payment_review" })).toBe(false);
    expect(invoiceDueFor(pay({ review_reason: "amount_mismatch", review_outcome: "accepted" }), { status: "paid" })).toBe(true);
    expect(invoiceDueFor(pay({ review_reason: "duplicate_payment", review_outcome: "refunded" }), { status: "paid" })).toBe(false);
  });

  it("storage extension payments are not invoiced yet", () => {
    expect(invoiceDueFor(pay({ purpose: "storage_extension" }), { status: "paid" })).toBe(false);
  });
});

describe("creditNoteDueFor (D146)", () => {
  it("only a succeeded refund with an issued invoice", () => {
    expect(creditNoteDueFor({ status: "succeeded" }, { status: "issued" })).toBe(true);
    for (const inv of [null, { status: "pending" as const }, { status: "failed" as const }]) expect(creditNoteDueFor({ status: "succeeded" }, inv)).toBe(false);
    for (const status of ["pending", "failed"] as const) expect(creditNoteDueFor({ status }, { status: "issued" })).toBe(false);
  });
});
