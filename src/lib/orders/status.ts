// Italian labels of order statuses (spec section 4).
export const ORDER_STATUS_LABEL: Record<string, string> = {
  draft: "Bozza",
  pending_payment: "In attesa di pagamento",
  expired: "Scaduto",
  paid: "Pagato",
  payment_review: "Pagamento da verificare",
  assigned: "Assegnato",
  picked_up: "Ritirato",
  in_transit: "In viaggio",
  delivered: "Consegnato",
  completed: "Completato",
  cancellation_review: "Annullamento in revisione",
  cancelled: "Annullato",
  refunded: "Rimborsato",
};

export type PaymentState = "to_pay" | "overdue" | "review" | "paid" | "not_paid" | "refunded";

export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  to_pay: "Da pagare",
  overdue: "Tempo scaduto",
  review: "In verifica",
  paid: "Pagato",
  not_paid: "Non pagato",
  refunded: "Rimborsato",
};

const PAID_STATUSES = new Set(["paid", "assigned", "picked_up", "in_transit", "delivered", "completed", "cancellation_review"]);

/**
 * Payment state shown in the panels, derived from the order status (set only by the webhook / database
 * functions) — never from the return from Checkout. cancelled: paid before unless nothing was charged.
 */
export function paymentState(o: { status: string; payment_due_at: string; paid_at: string | null; refunded_cents?: number | null; total_cents?: number | null }, now: Date): PaymentState {
  if (o.status === "pending_payment") return now < new Date(o.payment_due_at) ? "to_pay" : "overdue";
  if (o.status === "payment_review") return "review";
  if (o.status === "refunded") return "refunded";
  if (PAID_STATUSES.has(o.status)) return "paid";
  if (o.status === "cancelled") {
    if (!o.paid_at) return "not_paid";
    return o.refunded_cents && o.total_cents && o.refunded_cents >= o.total_cents ? "refunded" : "paid";
  }
  return "not_paid"; // draft, expired
}
