import { formatWindow, summaryLine, toOrderSummary, type OrderSummary, type OrderSummaryRow } from "./order-summary";

// A storage chain (D153): "ritiro Transigo → deposito → consegna Transigo" = linked orders. The first order of the
// chain is the root (parent_order_id null); the others point to it (one level). One payment (on the root), one
// invoice (on the root, lines of the whole group). Pure helpers; the database guarantees the shape
// (create_service_order, migration storage_chain).

export type ChainRole = "intake" | "storage" | "outbound";

export type GroupMemberRow = { id: string; order_number: string; service_type?: string | null; parent_order_id: string | null; created_at: string };

export type GroupMember<T extends GroupMemberRow> = T & { role: ChainRole | null };

/** The root of an order: itself, or the order it points to. */
export const groupRootId = (o: { id: string; parent_order_id: string | null }) => o.parent_order_id ?? o.id;

/** PostgREST filter for every order of the group of `rootId` (use with `.or()`). */
export const groupFilter = (rootId: string) => `id.eq.${rootId},parent_order_id.eq.${rootId}`;

/**
 * Members in chain order: the root first, then the storage order, then the transport after it. Role only in a
 * real chain (more than one order with a storage order); a single order
 * has role null. Throws on rows that are not one group.
 */
export function orderGroup<T extends GroupMemberRow>(rows: T[]): { root: GroupMember<T>; members: GroupMember<T>[] } {
  const root = rows.find((r) => r.parent_order_id === null);
  if (!root) throw new Error("order group without root");
  if (rows.some((r) => r.parent_order_id !== null && r.parent_order_id !== root.id)) throw new Error("rows of different groups");
  // Orders of one chain share created_at (one transaction): the chain order is explicit — the storage order comes
  // before the transports that follow it; then creation time and order number.
  const rank = (r: T) => (r.service_type === "storage" ? 0 : 1);
  const children = rows
    .filter((r) => r.parent_order_id !== null)
    .sort((a, b) => rank(a) - rank(b) || a.created_at.localeCompare(b.created_at) || a.order_number.localeCompare(b.order_number));
  const ordered = [root, ...children];
  const isChain = ordered.length > 1 && ordered.some((r) => r.service_type === "storage");
  const role = (r: T): ChainRole | null => {
    if (!isChain) return null;
    if (r.service_type === "storage") return "storage";
    return r === root ? "intake" : "outbound";
  };
  const members = ordered.map((r) => ({ ...r, role: role(r) }));
  return { root: members[0], members };
}

export const CHAIN_ROLE_LABEL: Record<ChainRole, string> = {
  intake: "Ritiro e trasporto al deposito",
  storage: "Deposito",
  outbound: "Consegna dal deposito",
};

export type ChainPart = { role: ChainRole; summary: OrderSummary };

/** The orders of a chain with their role, for Checkout and e-mails; undefined for a single order. */
export function chainParts(members: GroupMember<GroupMemberRow & OrderSummaryRow>[]): ChainPart[] | undefined {
  if (members.length < 2 || members.some((m) => !m.role)) return undefined;
  return members.map((m) => ({ role: m.role!, summary: toOrderSummary(m) }));
}

/** "Firenze → Firenze, giovedì 12 novembre 2026, tra le 10:00 e le 12:00" · "Deposito Box M dal … al …". */
export function chainPartText(p: ChainPart): string {
  const s = p.summary;
  if (s.service === "storage") return summaryLine(s);
  return `${summaryLine(s)}, ${formatWindow(s.window)}`;
}

/** E-mail / page rows of a chain: one row per order, in chain order. */
export const chainRows = (parts: ChainPart[]): [string, string][] => parts.map((p) => [CHAIN_ROLE_LABEL[p.role], chainPartText(p)]);

// ---------------------------------------------------------------------------
// Invoice of the group (D153): one document, lines of every order
// ---------------------------------------------------------------------------

export type GroupChargesRow = {
  customer_type: "private" | "business";
  vat_rate_bp: number;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  billing_details: Record<string, unknown>;
};
export type GroupLineRow = { sort_order: number; label_it: string; quantity: number; net_cents: number; vat_cents: number; gross_cents: number };

/** Spacing of the sort order per member: line k of member i → i × 1000 + k (an order has far fewer lines). */
const SORT_STEP = 1000;

/**
 * Charges and lines of the whole group for one invoice. Amounts are the sum of the members (integers, exact —
 * the same sum as queue_invoice()); customer type, VAT rate and billing details come from the root (the database
 * requires them equal in a chain). In a chain every line says which order it belongs to.
 */
export function mergeGroupForInvoice(
  members: { role: ChainRole | null; order_charges: GroupChargesRow; order_lines?: GroupLineRow[] }[],
): { charges: GroupChargesRow; lines: GroupLineRow[] } {
  if (members.length === 0) throw new Error("empty group");
  const root = members[0].order_charges;
  const sum = (k: "subtotal_cents" | "vat_cents" | "total_cents") => members.reduce((s, m) => s + m.order_charges[k], 0);
  const lines = members.flatMap((m, i) =>
    [...(m.order_lines ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((l) => ({
        ...l,
        sort_order: i * SORT_STEP + l.sort_order,
        label_it: m.role ? `${CHAIN_ROLE_LABEL[m.role]} – ${l.label_it}` : l.label_it,
      })),
  );
  return {
    charges: { ...root, subtotal_cents: sum("subtotal_cents"), vat_cents: sum("vat_cents"), total_cents: sum("total_cents") },
    lines,
  };
}

/** Total of the group in cents (what the customer pays once). */
export const groupTotalCents = (members: { order_charges: { total_cents: number } | null }[]) =>
  members.reduce((s, m) => {
    if (!m.order_charges) throw new Error("order without charges");
    return s + m.order_charges.total_cents;
  }, 0);
