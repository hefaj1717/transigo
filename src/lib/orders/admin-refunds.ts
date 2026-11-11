// Admin money decisions (D140–D142) — pure part: form parsing, the suggested amounts, labels, messages.
// The amounts that count are checked by the database (admin_decide_cancellation, admin_resolve_payment_review,
// admin_refund_order, admin_retry_refund — under the order row lock). Amounts in integer cents.
import { z } from "zod";
import { parseEuroToCents } from "@/lib/pricing/money";
import { cancellationPreview, type CancellationLine } from "./cancellation";

/** Reasons of a manual refund (D142) — the code goes to refunds.reason and the audit; details in "Note interne". */
export const MANUAL_REFUND_REASONS = [
  { code: "service_issue", label: "Problema nel servizio" },
  { code: "claim", label: "Reclamo" },
  { code: "goodwill", label: "Gesto commerciale" },
  { code: "price_correction", label: "Correzione del prezzo" },
  { code: "other", label: "Altro" },
] as const;
export type ManualRefundReason = (typeof MANUAL_REFUND_REASONS)[number]["code"];

/** Every refunds.reason code → label (manual + the ones written by the functions). */
export const REFUND_REASON_LABEL: Record<string, string> = {
  ...Object.fromEntries(MANUAL_REFUND_REASONS.map((r) => [r.code, r.label])),
  customer_cancellation: "Annullamento del cliente",
  cancellation_decision: "Decisione sull'annullamento",
  payment_review: "Pagamento da verificare",
};

export const REFUND_STATUS_LABEL: Record<string, string> = {
  pending: "In corso",
  succeeded: "Rimborsato",
  failed: "Non riuscito",
};

/** payments.review_reason (D96) → label. */
export const PAYMENT_REVIEW_REASON_LABEL: Record<string, string> = {
  amount_mismatch: "Importo diverso dall'ordine",
  currency_mismatch: "Valuta diversa da EUR",
  duplicate_payment: "Pagamento doppio",
  late_payment: "Pagato dopo la scadenza",
};

export const REFUND_MSG = {
  decided: (refundCents: number) => (refundCents > 0 ? "Annullamento deciso: rimborso avviato." : "Annullamento deciso, senza rimborso."),
  alreadyDecided: "L'annullamento era già stato deciso. Ricarica la pagina.",
  markedPaid: "Pagamento accettato: l'ordine è pagato e visibile ai padroncini.",
  reviewRefunded: "Pagamento rimborsato.",
  alreadyResolved: "Il pagamento era già stato gestito. Ricarica la pagina.",
  refunded: (full: boolean) => (full ? "Rimborso totale avviato." : "Rimborso parziale avviato."),
  retried: "Rimborso inviato di nuovo a Stripe.",
  stripePending: " Stripe non ha ancora confermato: lo stato si aggiornerà da solo (o usa «Riprova»).",
  stripeFailed: " Stripe ha rifiutato il rimborso: usa «Riprova».",
  invalidAmount: "Importo non valido (es. 12,50).",
  refundTooHigh: "Il rimborso supera l'importo ancora rimborsabile.",
  carrierTooHigh: "L'importo per il padroncino supera la sua quota dell'ordine.",
  chooseReason: "Scegli il motivo.",
  notInReview: "L'ordine non è più in «Annullamento in revisione». Ricarica la pagina.",
  paymentNotInReview: "Il pagamento non è più da verificare. Ricarica la pagina.",
  duplicateOnlyRefund: "Un pagamento doppio si può solo rimborsare.",
  notRefundable: "Questo ordine non si può rimborsare da qui.",
  noPayment: "L'ordine non ha un pagamento valido.",
  inProgress: "Corsa in corso: per il rimborso totale rimuovi prima il padroncino (oppure fai un rimborso parziale).",
  alreadySucceeded: "Il rimborso è già riuscito.",
  notFound: "Elemento non trovato.",
  generic: "Operazione non riuscita. Riprova.",
} as const;

type DbError = { code?: string | null; details?: string | null } | null;

/** Database error (22023 / 55000 + detail) → message for the admin. */
export function refundDbError(e: DbError): string {
  switch (e?.details) {
    case "refund_amount":
    case "amount":
      return REFUND_MSG.refundTooHigh;
    case "carrier_amount":
      return REFUND_MSG.carrierTooHigh;
    case "reason":
      return REFUND_MSG.chooseReason;
    case "not_in_review":
      return REFUND_MSG.notInReview;
    case "payment":
      return REFUND_MSG.paymentNotInReview;
    case "duplicate_payment":
      return REFUND_MSG.duplicateOnlyRefund;
    case "not_refundable":
      return REFUND_MSG.notRefundable;
    case "no_payment":
      return REFUND_MSG.noPayment;
    case "in_progress":
      return REFUND_MSG.inProgress;
    case "already_succeeded":
      return REFUND_MSG.alreadySucceeded;
    case "order":
    case "refund":
      return REFUND_MSG.notFound;
  }
  return REFUND_MSG.generic;
}

const uuid = z.uuid();
/** "12,50" → 1250; "0" allowed. */
const euro = z.string().transform((v, ctx) => {
  const cents = parseEuroToCents(v);
  if (cents === null) {
    ctx.addIssue({ code: "custom", message: REFUND_MSG.invalidAmount });
    return z.NEVER;
  }
  return cents;
});

export const decideCancellationSchema = z.object({ orderId: uuid, refund: euro, carrier: euro });
export const resolvePaymentReviewSchema = z.object({ paymentId: uuid, action: z.enum(["mark_paid", "refund"]) });
export const manualRefundSchema = z.object({
  orderId: uuid,
  amount: euro.refine((c) => c > 0, REFUND_MSG.invalidAmount),
  reason: z.enum(MANUAL_REFUND_REASONS.map((r) => r.code) as [ManualRefundReason, ...ManualRefundReason[]]),
});
export const retryRefundSchema = z.object({ refundId: uuid });

/** First form error → message (reason first: a missing select is the usual mistake). */
export function refundFormError(issues: readonly { path: readonly PropertyKey[] }[]): string {
  if (issues.some((i) => i.path[0] === "reason")) return REFUND_MSG.chooseReason;
  if (issues.some((i) => ["amount", "refund", "carrier"].includes(String(i.path[0])))) return REFUND_MSG.invalidAmount;
  return REFUND_MSG.generic;
}

export type RefundLike = { id: string; amount_cents: number; status: string; stripe_refund_id: string | null; retry_of: string | null };

/** Refunds that still count against the payment (not failed). */
export const activeRefundCents = (refunds: readonly Pick<RefundLike, "amount_cents" | "status">[]) =>
  refunds.filter((r) => r.status !== "failed").reduce((s, r) => s + r.amount_cents, 0);

/**
 * "Riprova" is offered for a refund that Stripe never got (pending without a Stripe id — the call failed) or that
 * failed and was not retried yet. A pending refund with a Stripe id is being processed by Stripe: wait.
 */
export function canRetryRefund(r: RefundLike, all: readonly RefundLike[]): boolean {
  if (r.status === "pending") return r.stripe_refund_id === null;
  if (r.status === "failed") return !all.some((x) => x.retry_of === r.id);
  return false;
}

export type DecisionSuggestion = { refundCents: number; feeCents: number; late: boolean };

/**
 * Suggested decision for a cancellation request (D140): the customer rule of D137 applied at the moment of the
 * request — free ≥ X h before pickup, otherwise the Y % fee; nothing suggested for the carrier (no automatic
 * compensation, D33). The admin may change both amounts.
 */
export function cancellationDecisionSuggestion(i: {
  requestedAt: Date;
  pickupWindowStart: Date;
  freeHours: number;
  feeBp: number;
  totalCents: number;
  refundedCents: number;
  lines: CancellationLine[];
}): DecisionSuggestion {
  const p = cancellationPreview({ status: "paid", now: i.requestedAt, pickupWindowStart: i.pickupWindowStart, freeHours: i.freeHours, feeBp: i.feeBp, totalCents: i.totalCents, refundedCents: i.refundedCents, lines: i.lines });
  if (p.kind !== "free" && p.kind !== "late") throw new Error("unexpected preview");
  return { refundCents: p.refundCents, feeCents: p.feeCents, late: p.kind === "late" };
}

/** Cents → the value of an input ("12,50"), for prefilled amounts. */
export const centsToInput = (cents: number) => `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
