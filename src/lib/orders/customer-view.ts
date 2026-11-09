// How the customer panel presents an order (spec 7). Pure — tested in customer-view.test.ts.
import { ORDER_STATUS_LABEL } from "./status";

/** Customer-facing wording where the admin label is too technical. */
export const CUSTOMER_STATUS_LABEL: Record<string, string> = {
  ...ORDER_STATUS_LABEL,
  paid: "Confermato",
  payment_review: "Pagamento in verifica",
  assigned: "Trasportatore assegnato",
  completed: "Consegnato",
  cancellation_review: "Annullamento in corso",
};

const FINISHED = new Set(["delivered", "completed", "cancelled", "refunded", "expired"]);

/** "In corso" (something still has to happen) or "Conclusi". */
export function orderGroup(status: string): "active" | "finished" {
  return FINISHED.has(status) ? "finished" : "active";
}

export type StatusTone = "neutral" | "info" | "progress" | "success" | "warning" | "muted";

export function statusTone(status: string): StatusTone {
  switch (status) {
    case "pending_payment":
    case "payment_review":
    case "cancellation_review":
      return "warning";
    case "paid":
      return "info";
    case "assigned":
    case "picked_up":
    case "in_transit":
      return "progress";
    case "delivered":
    case "completed":
      return "success";
    case "cancelled":
    case "refunded":
    case "expired":
      return "muted";
    default:
      return "neutral";
  }
}

export type ProgressStep = { key: string; label: string; state: "done" | "current" | "todo"; at: string | null };

const STEPS = [
  { key: "paid", label: "Confermato", column: "paid_at" },
  { key: "assigned", label: "Trasportatore assegnato", column: "assigned_at" },
  { key: "picked_up", label: "Ritirato", column: "picked_up_at" },
  { key: "in_transit", label: "In viaggio", column: "in_transit_at" },
  { key: "delivered", label: "Consegnato", column: "delivered_at" },
] as const;

type ProgressInput = {
  status: string;
  paid_at: string | null;
  assigned_at: string | null;
  picked_up_at: string | null;
  in_transit_at: string | null;
  delivered_at: string | null;
};

/**
 * Progress bar of a paid order: steps up to the current status are done, the current one is highlighted.
 * Times come from the order's columns (shown only for done steps). Orders that are not on this path
 * (unpaid, expired, cancelled, refunded, under review) get no bar.
 */
export function progressSteps(o: ProgressInput): ProgressStep[] | null {
  const status = o.status === "completed" ? "delivered" : o.status;
  const index = STEPS.findIndex((s) => s.key === status);
  if (index < 0) return null;
  return STEPS.map((s, i) => ({
    key: s.key,
    label: s.label,
    state: i < index || (i === index && s.key === "delivered") ? "done" : i === index ? "current" : "todo",
    at: i <= index ? o[s.column] : null,
  }));
}

/** "Milano → Torino" (via the warehouse when the order has two legs). */
export function routeSummary(legs: { leg_index: number; pickup_city: string; delivery_city: string }[]): string {
  const sorted = [...legs].sort((a, b) => a.leg_index - b.leg_index);
  if (!sorted.length) return "—";
  const from = sorted[0].pickup_city;
  const to = sorted[sorted.length - 1].delivery_city;
  return sorted.length > 1 ? `${from} → ${to} (con deposito)` : `${from} → ${to}`;
}
