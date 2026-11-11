// Admin dashboard (spec 9) — pure: the month in Europe/Rome, money of the month, the "da gestire" counters.
// Amounts in integer cents; every rounding is explicit.

const ROME = "Europe/Rome";

/** Offset of Europe/Rome from UTC at an instant, in minutes (60 or 120). */
function romeOffsetMinutes(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: ROME, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((wall - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** The instant of 00:00 in Rome on a calendar day. */
export function romeMidnight(year: number, month: number, day = 1): Date {
  const guess = Date.UTC(year, month - 1, day);
  // The offset at midnight Rome time: try the offset at the guess, correct once (DST changes happen at 2–3 am).
  const first = new Date(guess - romeOffsetMinutes(new Date(guess)) * 60_000);
  return new Date(guess - romeOffsetMinutes(first) * 60_000);
}

export type MonthRange = { key: string; label: string; start: Date; end: Date; prev: string; next: string | null };

const MONTHS_IT = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const key = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/** "?mese=2026-11" → that month in Rome; anything else (or a future month) → the current month. */
export function romeMonthRange(input: unknown, now: Date): MonthRange {
  const [cy, cm] = now.toLocaleDateString("sv-SE", { timeZone: ROME }).split("-").map(Number);
  let y = cy;
  let m = cm;
  const match = typeof input === "string" ? /^(\d{4})-(\d{2})$/.exec(input) : null;
  if (match) {
    const iy = +match[1];
    const im = +match[2];
    if (im >= 1 && im <= 12 && iy >= 2020 && (iy < cy || (iy === cy && im <= cm))) {
      y = iy;
      m = im;
    }
  }
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const isCurrent = y === cy && m === cm;
  return { key: key(y, m), label: `${MONTHS_IT[m - 1]} ${y}`, start: romeMidnight(y, m), end: romeMidnight(ny, nm), prev: key(py, pm), next: isCurrent ? null : key(ny, nm) };
}

export type FinanceOrder = {
  status: string;
  total_cents: number;
  subtotal_cents: number;
  /** Refunds Stripe confirmed (order_charges.refunded_cents). */
  refunded_cents: number;
  /** Sum of order_leg_carrier_terms.carrier_amount_cents. */
  carrier_amount_cents: number;
  /** Admin decision on a cancellation (D140), if any. */
  cancellation_carrier_cents: number | null;
};

export type MonthFinance = { orders: number; grossCents: number; netCents: number; carrierCents: number; marginCents: number; refundedCents: number };

/**
 * Money of the orders paid in the month (paid_at in the month; payment_review / pending / expired never count):
 *  - gross = total − confirmed refunds;
 *  - net (without VAT) = subtotal × gross / total, rounded half up to the cent per order (integers only);
 *  - carrier (expected, payouts come in stage 6) = carrier amount for orders that are carried out (not cancelled /
 *    refunded); for a cancellation the amount the admin decided (D140), otherwise 0;
 *  - margin = net − carrier.
 */
export function monthFinance(orders: readonly FinanceOrder[]): MonthFinance {
  let grossCents = 0;
  let netCents = 0;
  let carrierCents = 0;
  let refundedCents = 0;
  let count = 0;
  for (const o of orders) {
    if (["pending_payment", "expired", "payment_review", "draft"].includes(o.status)) continue;
    count += 1;
    const gross = Math.max(o.total_cents - o.refunded_cents, 0);
    grossCents += gross;
    refundedCents += o.refunded_cents;
    netCents += o.total_cents > 0 ? Math.floor((o.subtotal_cents * gross * 2 + o.total_cents) / (2 * o.total_cents)) : 0; // half up
    if (o.status === "cancelled" || o.status === "refunded") carrierCents += o.cancellation_carrier_cents ?? 0;
    else carrierCents += o.carrier_amount_cents;
  }
  return { orders: count, grossCents, netCents, carrierCents, marginCents: netCents - carrierCents, refundedCents };
}

export type DocLike = { carrier_id: string; vehicle_id: string | null; doc_type: string; expires_at: string | null; review_status: string; created_at: string };

/**
 * Carrier documents that expire within `days` (from today in Rome, inclusive): only the newest non-rejected document
 * of each (carrier, vehicle, type) counts — an older one replaced by a new upload is not a problem.
 */
export function expiringDocuments(docs: readonly DocLike[], now: Date, days = 30): DocLike[] {
  const today = now.toLocaleDateString("sv-SE", { timeZone: ROME });
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const newest = new Map<string, DocLike>();
  for (const d of docs) {
    if (d.review_status === "rejected") continue;
    const k = `${d.carrier_id}|${d.vehicle_id ?? ""}|${d.doc_type}`;
    const cur = newest.get(k);
    if (!cur || d.created_at > cur.created_at) newest.set(k, d);
  }
  return [...newest.values()].filter((d) => d.expires_at !== null && d.expires_at >= today && d.expires_at <= limit);
}

/** Paid orders nobody took within `hours` of payment (spec 9 alert, settings.unassigned_alert_hours). */
export function unassignedTooLong(orders: readonly { status: string; carrier_id: string | null; paid_at: string | null }[], hours: number, now: Date): number {
  const cutoff = now.getTime() - hours * 3_600_000;
  return orders.filter((o) => o.status === "paid" && !o.carrier_id && o.paid_at && Date.parse(o.paid_at) <= cutoff).length;
}
