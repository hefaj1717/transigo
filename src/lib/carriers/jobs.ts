// Carrier jobs screens — pure logic (D21, D116, D119–D121). Tested in jobs.test.ts.
// Amounts stay in cents here; formatting to "1.234,56 €" happens only in the UI (formatCents).
// Every time shown to the carrier is in Europe/Rome, whatever the server's time zone.
import type { PorterPackageCode, StorageType } from "../pricing/types";
import { PORTER_PACKAGE_LABEL } from "../pricing/rule-meta";
import { CARRIER_DOCUMENT_TYPES } from "./document-types";
import { CARRIER_PATHS } from "./onboarding";

export const JOB_PATHS = {
  available: "/padroncino/corse",
  available_job: (id: string) => `/padroncino/corse/${id}`,
  mine: "/padroncino/le-mie-corse",
  my_job: (id: string) => `/padroncino/le-mie-corse/${id}`,
} as const;

// ---------------------------------------------------------------------------
// Time in Europe/Rome
// ---------------------------------------------------------------------------

export const JOB_TIME_ZONE = "Europe/Rome";

const toDate = (d: Date | string) => (typeof d === "string" ? new Date(d) : d);

/** "08:00" in Rome. */
export function romeTime(d: Date | string): string {
  return toDate(d).toLocaleTimeString("it-IT", { timeZone: JOB_TIME_ZONE, hour: "2-digit", minute: "2-digit" });
}

/** "lunedì 10 novembre" in Rome. */
export function romeDay(d: Date | string): string {
  return toDate(d).toLocaleDateString("it-IT", { timeZone: JOB_TIME_ZONE, weekday: "long", day: "numeric", month: "long" });
}

/** "lunedì 10 novembre, 08:00–10:00" — a pickup window in Rome. */
export function romeWindow(start: Date | string, end: Date | string): string {
  return `${romeDay(start)}, ${romeTime(start)}–${romeTime(end)}`;
}

/** "10 novembre alle 08:00" — e.g. the "Rinuncia" deadline. */
export function romeDateTime(d: Date | string): string {
  const date = toDate(d).toLocaleDateString("it-IT", { timeZone: JOB_TIME_ZONE, day: "numeric", month: "long" });
  return `${date} alle ${romeTime(d)}`;
}

// ---------------------------------------------------------------------------
// Distance and driving time
// ---------------------------------------------------------------------------

/** 231400 m → "231 km"; under 10 km one decimal ("7,4 km"). */
export function formatKm(meters: number): string {
  const km = meters / 1000;
  if (km < 10) return `${(Math.round(km * 10) / 10).toLocaleString("it-IT")} km`;
  return `${Math.round(km).toLocaleString("it-IT")} km`;
}

/** 9300 s → "2 h 35 min"; 2700 s → "45 min" (rounded to the minute). */
export function formatDuration(seconds: number): string {
  const total = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// ---------------------------------------------------------------------------
// Available jobs (list_available_jobs) → cards
// ---------------------------------------------------------------------------

/** One leg as list_available_jobs returns it (jsonb). No street, coordinates, contacts (D119). */
export type AvailableJobLeg = {
  leg_index: number;
  pickup_city: string;
  pickup_province: string;
  pickup_is_warehouse: boolean;
  delivery_city: string;
  delivery_province: string;
  delivery_is_warehouse: boolean;
  distance_m: number;
  duration_s: number;
  pickup_date: string;
  pickup_window_start: string;
  pickup_window_end: string;
  pickup_floor: number | null;
  pickup_has_elevator: boolean | null;
  delivery_floor: number | null;
  delivery_has_elevator: boolean | null;
  is_urgent: boolean;
  porter_package_code: PorterPackageCode | null;
  porters_count: number | null;
  porters_included_hours: number | null;
  carrier_amount_cents: number | null;
};

export type AvailableJobRow = {
  order_id: string;
  order_number: string;
  vehicle_type_name: string;
  pickup_window_start: string;
  weight_kg: number | null;
  largest_item_length_cm: number | null;
  largest_item_width_cm: number | null;
  largest_item_height_cm: number | null;
  pallets_count: number | null;
  items_count: number | null;
  load_category: PorterPackageCode | null;
  packing_items_count: number | null;
  storage_type: StorageType | null;
  storage_days: number | null;
  carrier_amount_cents: number;
  transport_carrier_cents: number;
  porters_carrier_cents: number;
  packing_carrier_cents: number;
  legs: AvailableJobLeg[] | null;
  matching_vehicle_ids: string[];
};

export type RouteStop = { city: string; province: string; isWarehouse: boolean };

export type JobLegView = {
  legIndex: number;
  from: RouteStop;
  to: RouteStop;
  distanceM: number;
  durationS: number;
  pickupWindowStart: string;
  pickupWindowEnd: string;
  isUrgent: boolean;
  pickupFloor: string | null;
  deliveryFloor: string | null;
  porters: string | null;
  carrierAmountCents: number | null;
};

export type JobCard = {
  orderId: string;
  orderNumber: string;
  vehicleTypeName: string;
  stops: RouteStop[];
  legs: JobLegView[];
  pickupWindowStart: string;
  pickupWindowEnd: string;
  isUrgent: boolean;
  distanceM: number;
  durationS: number;
  load: string[];
  services: string[];
  amount: { totalCents: number; transportCents: number; portersCents: number; packingCents: number };
  matchingVehicleIds: string[];
};

/** "3° piano, con ascensore" / "Piano terra" / null when the floor is not given. */
export function floorLabel(floor: number | null, hasElevator: boolean | null): string | null {
  if (floor === null || floor === undefined) return null;
  const f = floor === 0 ? "Piano terra" : floor < 0 ? `Piano ${floor}` : `${floor}° piano`;
  if (floor === 0 || hasElevator === null || hasElevator === undefined) return f;
  return `${f}, ${hasElevator ? "con ascensore" : "senza ascensore"}`;
}

function portersLabel(leg: Pick<AvailableJobLeg, "porter_package_code" | "porters_count" | "porters_included_hours">): string | null {
  if (!leg.porters_count) return null;
  const who = leg.porters_count === 1 ? "1 facchino" : `${leg.porters_count} facchini`;
  const pkg = leg.porter_package_code ? ` (${PORTER_PACKAGE_LABEL[leg.porter_package_code]})` : "";
  const hours = leg.porters_included_hours ? `, ${leg.porters_included_hours} h incluse` : "";
  return `${who}${pkg}${hours}`;
}

/** Stops in order: pickup of leg 1, then each leg's delivery (the warehouse between legs appears once). */
export function routeStops(legs: readonly AvailableJobLeg[]): RouteStop[] {
  const sorted = [...legs].sort((a, b) => a.leg_index - b.leg_index);
  if (sorted.length === 0) return [];
  return [
    { city: sorted[0].pickup_city, province: sorted[0].pickup_province, isWarehouse: sorted[0].pickup_is_warehouse },
    ...sorted.map((l) => ({ city: l.delivery_city, province: l.delivery_province, isWarehouse: l.delivery_is_warehouse })),
  ];
}

/** "Milano (MI) → Magazzino Bologna (BO) → Roma (RM)". */
export function routeLabel(stops: readonly RouteStop[]): string {
  return stops.map((s) => `${s.isWarehouse ? "Magazzino " : ""}${s.city} (${s.province})`).join(" → ");
}

const STORAGE_LABEL: Record<StorageType, string> = {
  transshipment: "Transbordo in magazzino",
  short_term: "Deposito a breve termine",
  long_term: "Deposito a lungo termine",
};

export function toJobCard(row: AvailableJobRow): JobCard {
  const legs = [...(row.legs ?? [])].sort((a, b) => a.leg_index - b.leg_index);
  const first = legs[0];

  const load: string[] = [];
  if (row.load_category) load.push(PORTER_PACKAGE_LABEL[row.load_category]);
  if (row.weight_kg) load.push(`${row.weight_kg.toLocaleString("it-IT")} kg`);
  const dims = [row.largest_item_length_cm, row.largest_item_width_cm, row.largest_item_height_cm];
  if (dims.every((d) => d)) load.push(`Oggetto più grande ${dims.join(" × ")} cm`);
  if (row.pallets_count) load.push(row.pallets_count === 1 ? "1 pallet" : `${row.pallets_count} pallet`);
  if (row.items_count) load.push(row.items_count === 1 ? "1 collo" : `${row.items_count} colli`);

  const services: string[] = [];
  for (const l of legs) {
    const p = portersLabel(l);
    if (p) services.push(legs.length > 1 ? `Tratta ${l.leg_index + 1}: ${p}` : `Facchinaggio: ${p}`);
  }
  if (row.packing_items_count) services.push(`Imballaggio: ${row.packing_items_count} ${row.packing_items_count === 1 ? "oggetto" : "oggetti"}`);
  if (row.storage_type) {
    const days = row.storage_type === "transshipment" || !row.storage_days ? "" : `, ${row.storage_days} ${row.storage_days === 1 ? "giorno" : "giorni"}`;
    services.push(`${STORAGE_LABEL[row.storage_type]}${days}`);
  }

  return {
    orderId: row.order_id,
    orderNumber: row.order_number,
    vehicleTypeName: row.vehicle_type_name,
    stops: routeStops(legs),
    legs: legs.map((l) => ({
      legIndex: l.leg_index,
      from: { city: l.pickup_city, province: l.pickup_province, isWarehouse: l.pickup_is_warehouse },
      to: { city: l.delivery_city, province: l.delivery_province, isWarehouse: l.delivery_is_warehouse },
      distanceM: l.distance_m,
      durationS: l.duration_s,
      pickupWindowStart: l.pickup_window_start,
      pickupWindowEnd: l.pickup_window_end,
      isUrgent: l.is_urgent,
      pickupFloor: floorLabel(l.pickup_floor, l.pickup_has_elevator),
      deliveryFloor: floorLabel(l.delivery_floor, l.delivery_has_elevator),
      porters: portersLabel(l),
      carrierAmountCents: l.carrier_amount_cents,
    })),
    pickupWindowStart: first?.pickup_window_start ?? row.pickup_window_start,
    pickupWindowEnd: first?.pickup_window_end ?? row.pickup_window_start,
    isUrgent: legs.some((l) => l.is_urgent),
    distanceM: legs.reduce((s, l) => s + (l.distance_m ?? 0), 0),
    durationS: legs.reduce((s, l) => s + (l.duration_s ?? 0), 0),
    load,
    services,
    amount: {
      totalCents: row.carrier_amount_cents,
      transportCents: row.transport_carrier_cents,
      portersCents: row.porters_carrier_cents,
      packingCents: row.packing_carrier_cents,
    },
    matchingVehicleIds: row.matching_vehicle_ids ?? [],
  };
}

// ---------------------------------------------------------------------------
// Why the carrier gets no jobs (carrier_job_eligibility)
// ---------------------------------------------------------------------------

export type JobBlocker = { code: string; label: string; href: string };

/**
 * Blocker codes of carrier_job_blockers() ('carrier_not_active', 'document:<type>') plus "no ready vehicle"
 * when the carrier has none. Empty = the carrier can see jobs.
 */
export function describeJobBlockers(blockers: readonly string[], readyVehicleCount: number): JobBlocker[] {
  const out: JobBlocker[] = blockers.map((code) => {
    if (code === "carrier_not_active") {
      return { code, label: "Il tuo account non è attivo: non puoi vedere né accettare nuove corse.", href: CARRIER_PATHS.home };
    }
    if (code.startsWith("document:")) {
      const docType = code.slice("document:".length);
      const cfg = CARRIER_DOCUMENT_TYPES.find((t) => t.docType === docType);
      return {
        code,
        label: `${cfg?.labelIt ?? "Documento aziendale"}: serve un documento approvato e non scaduto.`,
        href: `${CARRIER_PATHS.documents}#${docType}`,
      };
    }
    return { code, label: "Il tuo account non può ancora accettare corse. Contatta Transigo.", href: CARRIER_PATHS.home };
  });
  // An inactive account says it all; vehicles matter only once the account itself may take jobs.
  if (readyVehicleCount === 0 && !blockers.includes("carrier_not_active")) {
    out.push({
      code: "no_ready_vehicle",
      label: "Nessun veicolo pronto: serve un veicolo attivo e approvato, con libretto e RCA approvati e non scaduti.",
      href: CARRIER_PATHS.vehicles,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// accept_job / release_job → messages
// ---------------------------------------------------------------------------

export const JOB_MSG = {
  accepted: "Corsa accettata. La trovi in «Le mie corse».",
  alreadyMine: "Hai già accettato questa corsa. La trovi in «Le mie corse».",
  alreadyTaken: "Questa corsa è già stata accettata da un altro padroncino.", // D120
  notAvailable: "Questa corsa non è più disponibile.",
  acceptTooLate: "Il ritiro di questa corsa è già iniziato: non è più possibile accettarla.",
  vehicleNotReady: "Il veicolo scelto non è pronto: controlla che sia approvato e che libretto e RCA siano validi.",
  vehicleNotSuitable: "Il veicolo scelto non è adatto a questa corsa.",
  chooseVehicle: "Scegli il veicolo per questa corsa.",
  notEligible: "Il tuo account non può accettare nuove corse in questo momento.",
  documents: "Per accettare corse servono documenti aziendali approvati e non scaduti.",
  notFound: "Corsa non trovata.",
  released: "Hai rinunciato alla corsa. Il team Transigo è stato avvisato.",
  releaseTooLate: "Il termine per rinunciare è scaduto. Per un problema con questa corsa contatta Transigo.",
  notAssigned: "Questa corsa non è più assegnata a te.",
  forbidden: "Operazione non consentita.",
  generic: "Si è verificato un errore. Riprova tra poco.",
} as const;

type DbError = { code?: string | null; message?: string | null; details?: string | null } | null | undefined;

/** `refreshList`: the job is gone for this carrier → reload "Corse disponibili" (e.g. already_taken). */
export type JobErrorView = { message: string; refreshList: boolean };

export function jobDbError(op: "accept" | "release", error: DbError): JobErrorView {
  const detail = error?.details ?? "";
  const fail = (message: string, refreshList = false): JobErrorView => ({ message, refreshList });
  switch (error?.code) {
    case "42501":
      if (detail.split(",").includes("carrier_not_active")) return fail(JOB_MSG.notEligible, true);
      if (detail.includes("document:")) return fail(JOB_MSG.documents, true);
      return fail(JOB_MSG.forbidden);
    case "22023":
      return detail === "vehicle" ? fail(JOB_MSG.chooseVehicle) : fail(JOB_MSG.notFound, op === "accept");
    case "55000":
      switch (detail) {
        case "already_taken":
          return fail(JOB_MSG.alreadyTaken, true);
        case "not_available":
          return fail(JOB_MSG.notAvailable, true);
        case "too_late":
          return op === "accept" ? fail(JOB_MSG.acceptTooLate, true) : fail(JOB_MSG.releaseTooLate);
        case "vehicle_not_ready":
          return fail(JOB_MSG.vehicleNotReady);
        case "vehicle_not_suitable":
          return fail(JOB_MSG.vehicleNotSuitable);
        case "not_assigned":
          return fail(JOB_MSG.notAssigned);
      }
  }
  return fail(JOB_MSG.generic);
}

/**
 * accept_job returns one row (assigned_at, newly_assigned). The same carrier accepting the same job again
 * (double click, second tab) gets newly_assigned = false and NO error — that is "already yours", never
 * "taken by someone else".
 */
export function acceptOutcome(data: unknown): { ok: true; newlyAssigned: boolean; message: string } | { ok: false; message: string } {
  const row = (Array.isArray(data) ? data[0] : data) as { newly_assigned?: unknown } | null | undefined;
  if (!row || typeof row.newly_assigned !== "boolean") return { ok: false, message: JOB_MSG.generic };
  return row.newly_assigned
    ? { ok: true, newlyAssigned: true, message: JOB_MSG.accepted }
    : { ok: true, newlyAssigned: false, message: JOB_MSG.alreadyMine };
}

// ---------------------------------------------------------------------------
// "Rinuncia" (D121) — DISPLAY ONLY. release_job() in the database always decides.
// ---------------------------------------------------------------------------

/** Same constants as release_job(): 15 min after accepting, or ≥ 48 h before the pickup window. */
export const RELEASE_GRACE_MS = 15 * 60 * 1000;
export const RELEASE_MIN_AHEAD_MS = 48 * 60 * 60 * 1000;

/**
 * release_job allows: now ≤ assigned_at + 15 min  OR  pickup_window_start ≥ now + 48 h (both inclusive),
 * i.e. now ≤ max(assigned_at + 15 min, pickup_window_start − 48 h). That maximum is the deadline.
 */
export function releaseDeadline(assignedAt: Date | string, pickupWindowStart: Date | string): Date {
  return new Date(Math.max(toDate(assignedAt).getTime() + RELEASE_GRACE_MS, toDate(pickupWindowStart).getTime() - RELEASE_MIN_AHEAD_MS));
}

export type ReleaseInfo =
  | { allowed: true; deadline: Date; label: string }
  | { allowed: false; reason: "status" | "expired"; deadline: Date | null };

/** For the "Rinuncia alla corsa" box. Only status 'assigned' (before pickup) can be released. */
export function releaseInfo(
  o: { status: string; assigned_at: string | null; pickup_window_start: string },
  now: Date,
): ReleaseInfo {
  if (o.status !== "assigned" || !o.assigned_at) return { allowed: false, reason: "status", deadline: null };
  const deadline = releaseDeadline(o.assigned_at, o.pickup_window_start);
  if (now.getTime() > deadline.getTime()) return { allowed: false, reason: "expired", deadline };
  return { allowed: true, deadline, label: `Puoi rinunciare fino al ${romeDateTime(deadline)}.` };
}

// ---------------------------------------------------------------------------
// Overlapping jobs (D120: allowed, the UI only warns)
// ---------------------------------------------------------------------------

/** A leg keeps the carrier busy from the start of its pickup window to the end of it plus the driving time. */
export type BusyLeg = { pickupWindowStart: string; pickupWindowEnd: string; durationS: number };
export type MyJobForOverlap = { orderId: string; orderNumber: string; status: string; legs: readonly BusyLeg[] };

const BUSY_STATUSES = new Set(["assigned", "picked_up", "in_transit"]);

function busyInterval(l: BusyLeg): [number, number] {
  return [new Date(l.pickupWindowStart).getTime(), new Date(l.pickupWindowEnd).getTime() + (l.durationS ?? 0) * 1000];
}

/** The carrier's own ongoing jobs whose busy time overlaps the candidate job's (touching ends do not count). */
export function overlappingJobs(
  candidate: { orderId: string; legs: readonly BusyLeg[] },
  mine: readonly MyJobForOverlap[],
): { orderId: string; orderNumber: string }[] {
  const cand = candidate.legs.map(busyInterval);
  return mine
    .filter((j) => j.orderId !== candidate.orderId && BUSY_STATUSES.has(j.status))
    .filter((j) => j.legs.map(busyInterval).some(([s, e]) => cand.some(([cs, ce]) => s < ce && cs < e)))
    .map((j) => ({ orderId: j.orderId, orderNumber: j.orderNumber }));
}

// ---------------------------------------------------------------------------
// "Le mie corse" tabs
// ---------------------------------------------------------------------------

export type MyJobTab = "da-fare" | "in-corso" | "concluse";

export const MY_JOB_TABS: { key: MyJobTab; label: string }[] = [
  { key: "da-fare", label: "Da fare" },
  { key: "in-corso", label: "In corso" },
  { key: "concluse", label: "Concluse" },
];

/** null = not shown to the carrier (e.g. a refunded order after cancellation). */
export function myJobTab(status: string): MyJobTab | null {
  switch (status) {
    case "assigned":
      return "da-fare";
    case "picked_up":
    case "in_transit":
      return "in-corso";
    case "delivered":
    case "completed":
      return "concluse";
    default:
      return null;
  }
}

export const CARRIER_JOB_STATUS_LABEL: Record<string, string> = {
  assigned: "Da ritirare",
  picked_up: "Ritirato",
  in_transit: "In viaggio",
  delivered: "Consegnato",
  completed: "Completato",
};

// ---------------------------------------------------------------------------
// Notice on "Corse disponibili" after a failed accept (?avviso=<JOB_MSG key>)
// ---------------------------------------------------------------------------

/**
 * The detail page sends the carrier back to the refreshed list with ?avviso=<key> when the job is gone for
 * them (e.g. already_taken, D120). Only JOB_MSG keys travel in the URL — never free text — and only these
 * keys are shown on the list.
 */
export const JOB_LIST_NOTICES = ["alreadyTaken", "notAvailable", "acceptTooLate", "notEligible", "documents", "notFound"] as const;
export type JobListNotice = (typeof JOB_LIST_NOTICES)[number];

/** JOB_MSG text → its key for ?avviso=, or null when the message is not a list notice. */
export function jobListNoticeKey(message: string): JobListNotice | null {
  return JOB_LIST_NOTICES.find((k) => JOB_MSG[k] === message) ?? null;
}

/** ?avviso= value → the Italian text to show, or null for anything else. */
export function jobListNotice(param: unknown): string | null {
  return typeof param === "string" && (JOB_LIST_NOTICES as readonly string[]).includes(param) ? JOB_MSG[param as JobListNotice] : null;
}
