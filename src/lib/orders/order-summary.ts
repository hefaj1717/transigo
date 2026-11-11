import { bookingUnitLabel, serviceTypeOf } from "./service-type";

// What an order is about, per service type (D151) — for e-mails and the Stripe Checkout description. Pure.
// Transport: route of the legs (first pickup → last delivery) and the pickup window of leg 0.
// Facchinaggio: the city and window of the porter job, persons and hours (no street — e-mails may go to the carrier
// and the admin, D119). Deposito: the unit and the period. Never amounts, never contacts.

/** Columns to select on `orders` for toOrderSummary(). Every caller reads them with the same shape. */
export const ORDER_SUMMARY_SELECT =
  "service_type, order_legs(leg_index, pickup_city, delivery_city, pickup_window_start, pickup_window_end), " +
  "order_porter_jobs(city, window_start, window_end, persons, billed_hours), " +
  "warehouse_bookings(start_date, end_date, unit, box_code, pallets)";

export type TimeWindow = { start: Date; end: Date };

export type OrderSummary =
  | { service: "transport"; pickupCity: string; deliveryCity: string; window: TimeWindow }
  | { service: "porters"; city: string; window: TimeWindow; persons: number; hours: number }
  | { service: "storage"; startDate: string; endDate: string; unitLabel: string };

type LegRow = { leg_index: number; pickup_city: string; delivery_city: string; pickup_window_start: string; pickup_window_end: string };
type PorterJobRow = { city: string; window_start: string; window_end: string; persons: number; billed_hours: number };
type BookingRow = { start_date: string; end_date: string; unit: string; box_code: string | null; pallets: number | null };

export type OrderSummaryRow = {
  service_type?: string | null;
  order_legs?: LegRow[] | null;
  // one-to-one embeds come back as an object (or null); arrays accepted too
  order_porter_jobs?: PorterJobRow | PorterJobRow[] | null;
  warehouse_bookings?: BookingRow | BookingRow[] | null;
};

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** Throws when the row lacks the data of its service (a broken snapshot must not produce an empty e-mail). */
export function toOrderSummary(row: OrderSummaryRow): OrderSummary {
  const service = serviceTypeOf(row.service_type);
  if (service === "porters") {
    const j = one(row.order_porter_jobs);
    if (!j) throw new Error("porters order without porter job");
    return { service, city: j.city, window: { start: new Date(j.window_start), end: new Date(j.window_end) }, persons: j.persons, hours: j.billed_hours };
  }
  if (service === "storage") {
    const b = one(row.warehouse_bookings);
    if (!b) throw new Error("storage order without booking");
    return { service, startDate: b.start_date, endDate: b.end_date, unitLabel: bookingUnitLabel(b) };
  }
  const legs = [...(row.order_legs ?? [])].sort((a, b) => a.leg_index - b.leg_index);
  if (legs.length === 0) throw new Error("transport order without legs");
  const first = legs[0];
  return {
    service,
    pickupCity: first.pickup_city,
    deliveryCity: legs[legs.length - 1].delivery_city,
    window: { start: new Date(first.pickup_window_start), end: new Date(first.pickup_window_end) },
  };
}

// ---------------------------------------------------------------------------
// Formatting (Italian, Europe/Rome)
// ---------------------------------------------------------------------------

const TZ = "Europe/Rome";
const day = (d: Date) => d.toLocaleDateString("it-IT", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
const time = (d: Date) => d.toLocaleTimeString("it-IT", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
/** 12/11/2026 from a date-only value (no time zone shift). */
const dateOnly = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

/** "giovedì 12 novembre 2026, tra le 10:00 e le 12:00" */
export const formatWindow = (w: TimeWindow) => `${day(w.start)}, tra le ${time(w.start)} e le ${time(w.end)}`;

/** One line: "Milano → Torino" · "Facchinaggio a Bologna" · "Deposito Box M dal 12/11/2026 al 20/12/2026". */
export function summaryLine(s: OrderSummary): string {
  switch (s.service) {
    case "transport":
      return `${s.pickupCity} → ${s.deliveryCity}`;
    case "porters":
      return `Facchinaggio a ${s.city}`;
    case "storage":
      return `Deposito ${s.unitLabel} dal ${dateOnly(s.startDate)} al ${dateOnly(s.endDate)}`;
  }
}

/** "2 facchini, 3 ore" */
export const portersTeamLabel = (persons: number, hours: number) => `${persons} facchini, ${hours} ${hours === 1 ? "ora" : "ore"}`;

/** Label of the start of the service: "Ritiro" (transport), "Inizio lavoro" (porters), "Inizio deposito". */
export function startLabel(s: OrderSummary): string {
  return s.service === "transport" ? "Ritiro" : s.service === "porters" ? "Inizio lavoro" : "Inizio deposito";
}

/** Window of the start, null for storage (a whole day, no time window). */
export const summaryWindow = (s: OrderSummary): TimeWindow | null => (s.service === "storage" ? null : s.window);

/** Table rows of an e-mail: what and when. */
export function summaryRows(s: OrderSummary): [string, string][] {
  switch (s.service) {
    case "transport":
      return [["Percorso", summaryLine(s)], ["Ritiro", formatWindow(s.window)]];
    case "porters":
      return [["Servizio", `Facchinaggio a ${s.city}`], ["Quando", formatWindow(s.window)], ["Squadra", portersTeamLabel(s.persons, s.hours)]];
    case "storage":
      return [["Deposito", s.unitLabel], ["Periodo", `dal ${dateOnly(s.startDate)} al ${dateOnly(s.endDate)}`]];
  }
}

/** Name of the Stripe Checkout line (D151): what the customer pays for. */
export function checkoutProductName(orderNumber: string, s: OrderSummary): string {
  const what = s.service === "transport" ? "Trasporto e servizi" : s.service === "porters" ? "Facchinaggio" : "Deposito";
  return `Ordine ${orderNumber} – ${what}`;
}
