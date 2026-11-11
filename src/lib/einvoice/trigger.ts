// WHEN a customer document is due — the only place that decides it (D147). Asked by the Stripe webhook after `paid`,
// by "Segna come pagato" (D141) and by the /api/cron/einvoice job (catches up whatever a call missed).
//
// Today (D2, pending the commercialista): the invoice right after the confirmed payment. Changing the moment (e.g.
// "after delivery") = changing THIS file and its tests; the callers stay the same.
// The database checks the same rules again (queue_invoice: accepted payment; queue_credit_note: issued invoice).

export const INVOICE_TRIGGER = "payment_confirmed" as const;

export type PaymentFacts = {
  purpose: "order" | "storage_extension";
  status: "pending" | "succeeded" | "expired" | "failed";
  review_reason: string | null;
  review_outcome: "accepted" | "refunded" | null;
};

export type OrderFacts = { status: string };

/**
 * Should this payment get its invoice now? A succeeded order payment that is not waiting for — or was accepted in —
 * the admin review (D96, D141). A payment refunded in review (e.g. a duplicate payment) never gets an invoice.
 * Storage extension payments (D26) are not built yet.
 */
export function invoiceDueFor(payment: PaymentFacts, order: OrderFacts): boolean {
  void order; // INVOICE_TRIGGER = "payment_confirmed": the order status does not matter (cancelled / refunded too)
  if (payment.purpose !== "order" || payment.status !== "succeeded") return false;
  return payment.review_reason === null || payment.review_outcome === "accepted";
}

/** A credit note waits for the issued invoice of the refund's payment (D146). */
export function creditNoteDueFor(refund: { status: "pending" | "succeeded" | "failed" }, invoice: { status: "pending" | "issued" | "failed" } | null): boolean {
  return refund.status === "succeeded" && invoice?.status === "issued";
}
