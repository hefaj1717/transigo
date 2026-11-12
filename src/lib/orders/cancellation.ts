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
  /** D170: a storage order is free until it starts (pickupWindowStart = 00:00 Europe/Rome of start_date), then no. */
  serviceType?: string | null;
};

export type CancellationPreview =
  /** basis: what the deadline refers to — the pickup (D33) or the start of the storage (D170). */
  | { kind: "free" | "late"; feeCents: number; refundCents: number; freeUntil: Date; basis: "pickup" | "storage" }
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
  if (i.serviceType === "storage") {
    // D170 (customer_cancel_order: storage_started): free with a full refund (D38) until 00:00 of the first day.
    if (i.now.getTime() >= i.pickupWindowStart.getTime()) return { kind: "not_allowed" };
    return { kind: "free", feeCents: 0, refundCents: Math.max(i.totalCents - i.refundedCents, 0), freeUntil: i.pickupWindowStart, basis: "storage" };
  }
  const freeUntil = freeCancellationUntil(i.pickupWindowStart, i.freeHours);
  // Same comparison as the database: from the deadline on (inclusive) the fee applies.
  const late = i.now.getTime() >= freeUntil.getTime();
  const feeCents = late ? Math.min(lateCancellationFeeCents(i.lines, i.feeBp), i.totalCents) : 0;
  const refundCents = Math.max(i.totalCents - feeCents - i.refundedCents, 0);
  return { kind: late ? "late" : "free", feeCents, refundCents, freeUntil, basis: "pickup" };
}

/**
 * A storage chain (D153, D169): cancelled only as a whole, only while every order is paid (no carrier) and the
 * storage has not started — the same rule as customer_cancel_order(). Fee and refund are the sums of the orders
 * (D33 per transport from its own pickup window, storage in full); the deadline shown is the earliest one.
 */
export function groupCancellationPreview(members: CancellationInput[]): CancellationPreview {
  if (members.length === 1) return cancellationPreview(members[0]);
  if (members.some((m) => m.status !== "paid")) return { kind: "not_allowed" };
  const previews = members.map(cancellationPreview);
  let feeCents = 0;
  let refundCents = 0;
  let late = false;
  let first: { at: Date; basis: "pickup" | "storage" } | null = null;
  for (const p of previews) {
    if (p.kind !== "free" && p.kind !== "late") return { kind: "not_allowed" };
    feeCents += p.feeCents;
    refundCents += p.refundCents;
    late ||= p.kind === "late";
    if (p.kind === "free" && (!first || p.freeUntil < first.at)) first = { at: p.freeUntil, basis: p.basis };
  }
  const deadline = first ?? { at: previews.map((p) => (p as { freeUntil: Date }).freeUntil).sort((a, b) => a.getTime() - b.getTime())[0], basis: "pickup" as const };
  return { kind: late ? "late" : "free", feeCents, refundCents, freeUntil: deadline.at, basis: deadline.basis };
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
