// Phase of a storage booking (warehouse_bookings, D153) for the panels — pure, tested in booking-phase.test.ts.
//
// Nothing sets warehouse_bookings.status to 'in_storage' / 'released' yet (step 9 of docs/plany/tre-servizi.md):
// until the admin records the arrival and the exit, the phase is derived from the dates and from the transports of
// the chain. A database status other than 'booked' always wins, so the derived phase steps aside once it exists.

export type BookingPhase = "unpaid" | "booked" | "incoming" | "stored" | "ended" | "left" | "cancelled";

export const BOOKING_PHASE_LABEL: Record<BookingPhase, string> = {
  unpaid: "In attesa di pagamento",
  booked: "Prenotato",
  incoming: "In arrivo al magazzino",
  stored: "In deposito",
  ended: "Periodo terminato",
  left: "Uscito dal magazzino",
  cancelled: "Annullato",
};

export type BookingPhaseTone = "warning" | "info" | "progress" | "success" | "muted";

export const BOOKING_PHASE_TONE: Record<BookingPhase, BookingPhaseTone> = {
  unpaid: "warning",
  booked: "info",
  incoming: "progress",
  stored: "progress",
  ended: "warning",
  left: "success",
  cancelled: "muted",
};

/** Phases in which the booking still occupies (or will occupy) the warehouse — "In corso". */
export const isOpenBookingPhase = (p: BookingPhase) => p === "unpaid" || p === "booked" || p === "incoming" || p === "stored";

export type BookingPhaseInput = {
  /** Status of the storage order itself. */
  orderStatus: string;
  booking: { start_date: string; end_date: string; intake: string; outbound: string; status: string };
  /** Status of the "ritiro Transigo" transport of the chain (intake = 'transigo'), if loaded. */
  intakeStatus?: string | null;
  /** Status of the "consegna Transigo" transport of the chain (outbound = 'transigo'), if loaded. */
  outboundStatus?: string | null;
  /** Today in Europe/Rome, YYYY-MM-DD (see romeToday). */
  today: string;
};

const UNPAID = new Set(["draft", "pending_payment", "payment_review"]);
const GONE = new Set(["cancelled", "refunded", "expired"]);
const MOVING = new Set(["picked_up", "in_transit"]);
const ARRIVED = new Set(["delivered", "completed"]);
const OUT = new Set(["picked_up", "in_transit", "delivered", "completed"]);

export function bookingPhase(i: BookingPhaseInput): BookingPhase {
  const b = i.booking;
  if (b.status === "cancelled" || GONE.has(i.orderStatus)) return "cancelled";
  if (UNPAID.has(i.orderStatus)) return "unpaid";
  if (b.status === "released") return "left";
  // The goods leave with the delivery transport (from its pickup at the warehouse).
  if (b.outbound === "transigo" && i.outboundStatus && OUT.has(i.outboundStatus)) return "left";
  const ended = i.today > b.end_date;
  if (b.status === "in_storage") return ended ? "ended" : "stored";

  let inside: boolean;
  if (b.intake === "transigo") {
    if (i.intakeStatus && MOVING.has(i.intakeStatus)) return "incoming";
    inside = !!i.intakeStatus && ARRIVED.has(i.intakeStatus);
  } else {
    // "La porti tu": no arrival is recorded — from the first day of the period the goods count as stored.
    inside = i.today >= b.start_date;
  }
  if (!inside) return i.today >= b.start_date && b.intake === "transigo" ? "incoming" : "booked";
  // Paid period over and nothing recorded the exit: the admin has to check (pickup, extension or a call).
  return ended ? "ended" : "stored";
}

/** Today in Europe/Rome as YYYY-MM-DD — compared with the booking's date-only columns. */
export const romeToday = (now: Date) => now.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });

export type PhaseMember = {
  service_type?: string | null;
  status: string;
  /** Role in a storage chain (order-group.ts); null outside a chain. */
  role: "intake" | "storage" | "outbound" | null;
  warehouse_bookings?: BookingPhaseInput["booking"] | null;
};

/** Phase of the storage booking of a group (a chain or a single storage order); null when there is none. */
export function groupBookingPhase(members: PhaseMember[], today: string): BookingPhase | null {
  const storage = members.find((m) => m.service_type === "storage" && m.warehouse_bookings);
  if (!storage?.warehouse_bookings) return null;
  return bookingPhase({
    orderStatus: storage.status,
    booking: storage.warehouse_bookings,
    intakeStatus: members.find((m) => m.role === "intake")?.status ?? null,
    outboundStatus: members.find((m) => m.role === "outbound")?.status ?? null,
    today,
  });
}
