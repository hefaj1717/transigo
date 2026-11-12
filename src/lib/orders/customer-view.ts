// How the customer panel presents an order (spec 7). Pure — tested in customer-view.test.ts.
import { orderGroup as groupMembers, type GroupMember } from "./order-group";
import { bookingUnitLabel, SERVICE_TYPE_LABEL, serviceTypeOf } from "./service-type";
import { ORDER_STATUS_LABEL, orderStatusLabel } from "./status";

/** Customer-facing wording where the admin label is too technical. */
export const CUSTOMER_STATUS_LABEL: Record<string, string> = {
  ...ORDER_STATUS_LABEL,
  paid: "Confermato",
  payment_review: "Pagamento in verifica",
  assigned: "Trasportatore assegnato",
  completed: "Consegnato",
  cancellation_review: "Annullamento in corso",
};

/** The customer's wording per service (D165): "Facchini assegnati", "Lavoro iniziato", "Lavoro concluso". */
export function customerStatusLabel(status: string, serviceType?: string | null): string {
  if (serviceType === "porters") {
    if (status === "assigned") return "Facchini assegnati";
    if (status === "picked_up" || status === "delivered" || status === "completed") return orderStatusLabel(status, serviceType);
  }
  return CUSTOMER_STATUS_LABEL[status] ?? status;
}

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

type StepDef = { key: string; label: string; column: "paid_at" | "assigned_at" | "picked_up_at" | "in_transit_at" | "delivered_at" };

const STEPS: readonly StepDef[] = [
  { key: "paid", label: "Confermato", column: "paid_at" },
  { key: "assigned", label: "Trasportatore assegnato", column: "assigned_at" },
  { key: "picked_up", label: "Ritirato", column: "picked_up_at" },
  { key: "in_transit", label: "In viaggio", column: "in_transit_at" },
  { key: "delivered", label: "Consegnato", column: "delivered_at" },
];

/** Facchinaggio (D165): no "In viaggio". */
const PORTERS_STEPS: readonly StepDef[] = [
  { key: "paid", label: "Confermato", column: "paid_at" },
  { key: "assigned", label: "Facchini assegnati", column: "assigned_at" },
  { key: "picked_up", label: "Lavoro iniziato", column: "picked_up_at" },
  { key: "delivered", label: "Lavoro concluso", column: "delivered_at" },
];

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
export function progressSteps(o: ProgressInput, serviceType?: string | null): ProgressStep[] | null {
  const steps = serviceType === "porters" ? PORTERS_STEPS : STEPS;
  const status = o.status === "completed" ? "delivered" : o.status;
  const index = steps.findIndex((s) => s.key === status);
  if (index < 0) return null;
  return steps.map((s, i) => ({
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

/**
 * Title of an order card / page (D151): the route for transport, "Facchinaggio · Firenze" for porters only,
 * "Deposito · Box M" for storage only. Orders without legs never fall back to "—" when their job or booking is there.
 */
export function orderTitle(o: {
  service_type?: string | null;
  order_legs: { leg_index: number; pickup_city: string; delivery_city: string }[];
  order_porter_jobs?: { city: string } | null;
  warehouse_bookings?: { unit: string; box_code: string | null; pallets: number | null } | null;
}): string {
  const type = serviceTypeOf(o.service_type);
  if (type === "porters") return o.order_porter_jobs ? `${SERVICE_TYPE_LABEL.porters} · ${o.order_porter_jobs.city}` : SERVICE_TYPE_LABEL.porters;
  if (type === "storage") return o.warehouse_bookings ? `${SERVICE_TYPE_LABEL.storage} · ${bookingUnitLabel(o.warehouse_bookings)}` : SERVICE_TYPE_LABEL.storage;
  return routeSummary(o.order_legs);
}

// ---------------------------------------------------------------------------
// "I miei ordini" (step 9 of docs/plany/tre-servizi.md): a storage chain (D153) is one card
// ---------------------------------------------------------------------------

export type ListRow = {
  id: string;
  order_number: string;
  service_type?: string | null;
  parent_order_id: string | null;
  status: string;
  created_at: string;
  pickup_window_start: string;
  order_charges: { total_cents: number; refunded_cents: number } | null;
};

export type ListEntry<T extends ListRow> = {
  /** The order that carries the payment (the chain root, or the order itself). */
  root: GroupMember<T>;
  /** Chain order; one element for an order that is not part of a chain. */
  members: GroupMember<T>[];
  /** "In corso" while any order of the group still has something to happen (D169: the group is one booking). */
  tab: "active" | "finished";
  /** Sum of the group (one payment on the root). */
  totalCents: number | null;
  refundedCents: number;
  /** Earliest pickup of the group — the list order. */
  startsAt: string;
};

/**
 * Groups the customer's orders: every chain becomes one entry with its members in chain order; other orders stay
 * one per entry. A child whose root is not among the rows (should not happen — the customer reads their whole
 * group) is shown on its own rather than hidden.
 */
export function customerListEntries<T extends ListRow>(rows: T[]): ListEntry<T>[] {
  const byRoot = new Map<string, T[]>();
  for (const r of rows) {
    const key = r.parent_order_id && rows.some((x) => x.id === r.parent_order_id) ? r.parent_order_id : r.id;
    byRoot.set(key, [...(byRoot.get(key) ?? []), r]);
  }
  return [...byRoot.values()].map((group) => {
    const { root, members } = groupMembers(group.map((r) => (r.parent_order_id && group.length === 1 ? { ...r, parent_order_id: null } : r)));
    const charges = members.map((m) => m.order_charges);
    return {
      root,
      members,
      tab: members.some((m) => orderGroup(m.status) === "active") ? "active" : "finished",
      totalCents: charges.every(Boolean) ? charges.reduce((s, c) => s + c!.total_cents, 0) : null,
      refundedCents: charges.reduce((s, c) => s + (c?.refunded_cents ?? 0), 0),
      startsAt: members.map((m) => m.pickup_window_start).sort()[0],
    };
  });
}
