// Service type of an order (D151): what the order is — transport, porters only (Facchinaggio) or storage only
// (Deposito). Labels in Italian (UI), codes as in the database (orders.service_type).

export const SERVICE_TYPES = ["transport", "porters", "storage"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_TYPE_LABEL: Record<ServiceType, string> = {
  transport: "Trasporto",
  porters: "Facchinaggio",
  storage: "Deposito",
};

/** Unknown values (e.g. a newer code than this build) are shown as transport — the only type before D151. */
export function serviceTypeOf(value: string | null | undefined): ServiceType {
  return (SERVICE_TYPES as readonly string[]).includes(value ?? "") ? (value as ServiceType) : "transport";
}

/** Filter of /admin/ordini (?servizio=…): key in the URL (Italian) → service type; "tutti" = no filter. */
export const SERVICE_FILTERS: { key: string; label: string; type: ServiceType | null }[] = [
  { key: "tutti", label: "Tutti", type: null },
  { key: "trasporto", label: SERVICE_TYPE_LABEL.transport, type: "transport" },
  { key: "facchinaggio", label: SERVICE_TYPE_LABEL.porters, type: "porters" },
  { key: "deposito", label: SERVICE_TYPE_LABEL.storage, type: "storage" },
];

export function serviceFilter(param: string | string[] | undefined) {
  const key = Array.isArray(param) ? param[0] : param;
  return SERVICE_FILTERS.find((f) => f.key === key) ?? SERVICE_FILTERS[0];
}

/** Storage orders are never dispatched to carriers (D152): no "Da assegnare" and no unassigned alert for them. */
export const dispatchable = (type: ServiceType) => type !== "storage";

// ---------------------------------------------------------------------------
// Storage booking (warehouse_bookings) — labels and the length of the period
// ---------------------------------------------------------------------------

export const STORAGE_INTAKE_LABEL: Record<string, string> = {
  self: "Porta il cliente",
  transigo: "Ritiro Transigo",
};

export const STORAGE_OUTBOUND_LABEL: Record<string, string> = {
  self: "Ritira il cliente",
  transigo: "Consegna Transigo",
  later: "Da decidere",
};

/** The same for the customer (second person). */
export const CUSTOMER_STORAGE_INTAKE_LABEL: Record<string, string> = {
  self: "La porti tu in magazzino",
  transigo: "Ritiro a cura di Transigo",
};

export const CUSTOMER_STORAGE_OUTBOUND_LABEL: Record<string, string> = {
  self: "La ritiri tu in magazzino",
  transigo: "Consegna a cura di Transigo",
  later: "Da decidere più avanti",
};

export const STORAGE_BOOKING_STATUS_LABEL: Record<string, string> = {
  booked: "Prenotato",
  in_storage: "In deposito",
  released: "Ritirato",
  cancelled: "Annullato",
};

/** Days of a booking: start_date … end_date inclusive (same rule as the database, D154). */
export function bookingDays(startDate: string, endDate: string): number {
  const ms = Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** "Box M" / "3 pallet" — what the booking occupies. */
export function bookingUnitLabel(b: { unit: string; box_code: string | null; pallets: number | null }): string {
  if (b.unit === "box") return `Box ${(b.box_code ?? "").toUpperCase()}`;
  return `${b.pallets ?? 0} pallet`; // invariable in Italian
}

/** 12/11/2026 from a date-only value (no time zone shift). */
export function formatDateOnly(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}
