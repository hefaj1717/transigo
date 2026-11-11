// Customer cancellation of a paid order (D33, D38, D137) — the PREVIEW shown before the customer confirms.
// The amounts that count are computed by the database (customer_cancel_order, under the order row lock, with the
// database clock); this module mirrors the same rule so the dialog shows the same numbers. Both are checked on the
// same examples in tests/rls/customer-cancellation.test.ts. Pure: amounts in integer cents.

export type CancellationLine = { line_type: string; gross_cents: number };

/**
 * Late-cancellation fee: `feeBp` basis points of the gross order lines except storage (D38 — storage that has not
 * started is refunded in full). Rounded half up to the cent: (base × bp + 5000) div 10000, integers only — the same
 * expression as public.order_late_cancellation_fee().
 */
export function lateCancellationFeeCents(lines: CancellationLine[], feeBp: number): number {
  if (!Number.isInteger(feeBp) || feeBp < 0 || feeBp > 10_000) throw new Error(`invalid fee bp ${feeBp}`);
  const base = lines.filter((l) => l.line_type !== "storage").reduce((sum, l) => sum + l.gross_cents, 0);
  return Math.floor((base * feeBp + 5_000) / 10_000);
}

export type CancellationInput = {
  status: string;
  pickupWindowStart: Date;
  now: Date;
  freeHours: number;
  feeBp: number;
  totalCents: number;
  /** Refunds already made or in progress (not failed). */
  refundedCents: number;
  lines: CancellationLine[];
};

export type CancellationPreview =
  | { kind: "free" | "late"; feeCents: number; refundCents: number; freeUntil: Date }
  /** Carrier already assigned: the customer requests it, the admin decides (D33). */
  | { kind: "review" }
  /** picked_up and later, unpaid, already cancelled…: no cancellation from the app. */
  | { kind: "not_allowed" };

/** The free-cancellation deadline: `freeHours` before the start of the pickup window. */
export function freeCancellationUntil(pickupWindowStart: Date, freeHours: number): Date {
  return new Date(pickupWindowStart.getTime() - freeHours * 3_600_000);
}

export function cancellationPreview(i: CancellationInput): CancellationPreview {
  if (i.status === "assigned") return { kind: "review" };
  if (i.status !== "paid") return { kind: "not_allowed" };
  const freeUntil = freeCancellationUntil(i.pickupWindowStart, i.freeHours);
  // Same comparison as the database: from the deadline on (inclusive) the fee applies.
  const late = i.now.getTime() >= freeUntil.getTime();
  const feeCents = late ? Math.min(lateCancellationFeeCents(i.lines, i.feeBp), i.totalCents) : 0;
  const refundCents = Math.max(i.totalCents - feeCents - i.refundedCents, 0);
  return { kind: late ? "late" : "free", feeCents, refundCents, freeUntil };
}

/** The customer may see the cancel button (the database decides again on click). */
export const CUSTOMER_CANCELLABLE_STATUSES = ["paid", "assigned"] as const;

export type RefundStatus = "pending" | "succeeded" | "failed";

/** Stripe Refund.status → refunds.status. requires_action / pending stay pending; canceled counts as failed. */
export function refundStatusFromStripe(status: string | null | undefined): RefundStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "canceled") return "failed";
  return "pending";
}
