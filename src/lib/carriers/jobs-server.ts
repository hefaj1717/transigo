import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/notifications/email";
import { CARRIER_RELEASED_JOB_TEMPLATE, renderCarrierReleasedJobEmail } from "@/lib/notifications/templates/carrier-released-job";
import { sendOrderAssignedEmail } from "@/lib/orders/customer-emails";
import {
  acceptOutcome,
  busyLegsOf,
  carrierJobStatusLabel,
  describeJobBlockers,
  JOB_MSG,
  jobDbError,
  myJobTab,
  overlappingJobs,
  releaseInfo,
  toJobCard,
  toPorterJobCard,
  type AvailableJobLeg,
  type AvailableJobRow,
  type AvailablePorterJobRow,
  type JobBlocker,
  type JobCard,
  type MyJobTab,
  type ReleaseInfo,
} from "./jobs";

// Carrier job screens — server side (D21, D116, D119–D121).
//
// Every read and every RPC runs with the carrier's OWN session client (`db`): RLS, list_available_jobs (no
// personal data before accepting, D119), accept_job / release_job (they take the carrier from auth.uid()).
// `userId` comes from the verified session and is only used as an extra filter next to RLS.
//
// The service role is used for ONE thing: queuing an e-mail in email_outbox, and only AFTER the RPC succeeded.
// It is passed as a factory (`notify.serviceDb()`), so it is not even created before that. An e-mail failure
// (including a missing ADMIN_NOTIFICATION_EMAIL) never undoes the accept / release — it is only logged.
// Kept apart from the Server Actions so tests/rls can run it against the local database.

export type JobNotifyDeps = {
  /** Service-role client factory, called only after a successful accept_job / release_job. */
  serviceDb: () => SupabaseClient;
  /** ADMIN_NOTIFICATION_EMAIL; null = not configured (the release still succeeds, the error is logged). */
  adminEmail: string | null;
  appUrl: string;
};

type DbError = { code?: string | null; message?: string | null; details?: string | null } | null;
const logDbError = (where: string, error: DbError) =>
  console.error(`[jobs] ${where}:`, error?.code ?? "", error?.details ?? "", error?.message ?? ""); // ids / codes only
const logMailError = (template: string, orderId: string, e: unknown) =>
  console.error(`[jobs] ${template} e-mail failed`, { orderId, error: e instanceof Error ? e.message : String(e) });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);

// ---------------------------------------------------------------------------
// Eligibility and "Corse disponibili"
// ---------------------------------------------------------------------------

export type Eligibility = { blockers: JobBlocker[]; readyVehicleIds: string[] };

export async function loadEligibility(db: SupabaseClient): Promise<Eligibility> {
  const { data, error } = await db.rpc("carrier_job_eligibility").single<{ blockers: string[] | null; ready_vehicle_ids: string[] | null }>();
  if (error || !data) {
    logDbError("carrier_job_eligibility", error);
    throw new Error("job eligibility unavailable");
  }
  const ready = data.ready_vehicle_ids ?? [];
  return { blockers: describeJobBlockers(data.blockers ?? [], ready.length), readyVehicleIds: ready };
}

export type AvailableJobsResult = { ok: true; jobs: JobCard[] } | { ok: false; blockers: JobBlocker[] };

/**
 * The list — transport jobs matching a ready vehicle and Facchinaggio jobs matching the team (D152, D164), by start
 * time — or why the carrier gets none (the database refuses with 42501 + blocker codes; the same blockers for both).
 */
export async function listAvailableJobs(db: SupabaseClient): Promise<AvailableJobsResult> {
  const [transport, porters] = await Promise.all([db.rpc("list_available_jobs"), db.rpc("list_available_porter_jobs")]);
  const error = transport.error ?? porters.error;
  if (error) {
    if (error.code === "42501") return { ok: false, blockers: (await loadEligibility(db)).blockers };
    logDbError(transport.error ? "list_available_jobs" : "list_available_porter_jobs", error);
    throw new Error("available jobs unavailable");
  }
  const jobs = [
    ...((transport.data ?? []) as AvailableJobRow[]).map(toJobCard),
    ...((porters.data ?? []) as AvailablePorterJobRow[]).map(toPorterJobCard),
  ].sort((a, b) => a.pickupWindowStart.localeCompare(b.pickupWindowStart) || a.orderNumber.localeCompare(b.orderNumber));
  return { ok: true, jobs };
}

export type JobVehicle = { id: string; plate: string; vehicleTypeName: string };

export type AvailableJobPage =
  | { kind: "available"; job: JobCard; vehicles: JobVehicle[]; overlaps: { orderId: string; orderNumber: string }[] }
  | { kind: "mine" } // already accepted by this carrier → show it in "Le mie corse"
  | { kind: "unavailable" } // taken by someone else, cancelled, started, or no matching vehicle
  | { kind: "blocked"; blockers: JobBlocker[] };

/** One available job (no personal data, D119), the carrier's vehicles that fit it and overlapping own jobs (D120). */
export async function loadAvailableJob(db: SupabaseClient, userId: string, orderId: string): Promise<AvailableJobPage> {
  if (!isUuid(orderId)) return { kind: "unavailable" };
  const { data, error } = await db.rpc("list_available_jobs", { p_order_id: orderId });
  if (error) {
    if (error.code === "42501") return { kind: "blocked", blockers: (await loadEligibility(db)).blockers };
    logDbError("list_available_jobs(one)", error);
    throw new Error("available job unavailable");
  }
  const row = ((data ?? []) as AvailableJobRow[])[0];
  if (!row) {
    // Facchinaggio (D164): no vehicle to choose; the overlap warning uses the work window + hours.
    const { data: porterRows, error: porterError } = await db.rpc("list_available_porter_jobs", { p_order_id: orderId });
    if (porterError) {
      logDbError("list_available_porter_jobs(one)", porterError);
      throw new Error("available job unavailable");
    }
    const porterRow = ((porterRows ?? []) as AvailablePorterJobRow[])[0];
    if (porterRow) {
      const job = toPorterJobCard(porterRow);
      const myJobs = await loadMyJobs(db, userId);
      return { kind: "available", job, vehicles: [], overlaps: overlappingJobs({ orderId: job.orderId, legs: busyLegsOf(job) }, myJobs) };
    }
    const { data: mine } = await db.from("orders").select("id").eq("id", orderId).eq("carrier_id", userId).maybeSingle();
    return mine ? { kind: "mine" } : { kind: "unavailable" };
  }
  const job = toJobCard(row);

  const [vehiclesRes, myJobs] = await Promise.all([
    job.matchingVehicleIds.length
      ? db.from("carrier_vehicles").select("id, plate, vehicle_types(name_it)").eq("carrier_id", userId).in("id", job.matchingVehicleIds).order("created_at")
      : Promise.resolve({ data: [], error: null }),
    loadMyJobs(db, userId),
  ]);
  if (vehiclesRes.error) {
    logDbError("job vehicles", vehiclesRes.error);
    throw new Error("vehicles unavailable");
  }
  const vehicles = ((vehiclesRes.data ?? []) as unknown as { id: string; plate: string; vehicle_types: { name_it: string } | null }[]).map((v) => ({
    id: v.id,
    plate: v.plate,
    vehicleTypeName: v.vehicle_types?.name_it ?? "—",
  }));
  return { kind: "available", job, vehicles, overlaps: overlappingJobs({ orderId: job.orderId, legs: busyLegsOf(job) }, myJobs) };
}

// ---------------------------------------------------------------------------
// "Le mie corse" — the carrier's own orders through RLS (orders_select_carrier)
// ---------------------------------------------------------------------------

const MY_JOB_COLUMNS = [
  "id, order_number, service_type, status, assigned_at, picked_up_at, in_transit_at, delivered_at, completed_at, pickup_window_start",
  "weight_kg, largest_item_length_cm, largest_item_width_cm, largest_item_height_cm, pallets_count, items_count, load_category",
  "packing_items_count, storage_type, storage_days, carrier_vehicle_id, vehicle_types(name_it)",
  // Facchinaggio (D164): the job and the carrier's amount (FK to order_porter_jobs — nested under it)
  "order_porter_jobs(city, province, job_date, window_start, window_end, persons, requested_hours, billed_hours, floor, has_elevator, is_urgent, order_porter_carrier_terms(carrier_amount_cents))",
].join(", ");

const LEG_COLUMNS = [
  "leg_index, pickup_city, pickup_province, pickup_warehouse_id, delivery_city, delivery_province, delivery_warehouse_id",
  "distance_m, duration_s, pickup_date, pickup_window_start, pickup_window_end, pickup_floor, pickup_has_elevator",
  "delivery_floor, delivery_has_elevator, is_urgent, porter_package_code, porters_count, porters_included_hours",
  "order_leg_carrier_terms(carrier_amount_cents, transport_carrier_cents, porters_carrier_cents, packing_carrier_cents)",
].join(", ");

/** Only after accepting (the order is the carrier's): addresses, contacts, goods description, notes. */
const PERSONAL_COLUMNS = "goods_description, goods_dimensions_note, customer_notes, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone";
const PERSONAL_LEG_COLUMNS = "pickup_address, pickup_postal_code, pickup_lat, pickup_lng, delivery_address, delivery_postal_code, delivery_lat, delivery_lng";

type Terms = { carrier_amount_cents: number; transport_carrier_cents: number; porters_carrier_cents: number; packing_carrier_cents: number };
type LegRow = Omit<AvailableJobLeg, "pickup_is_warehouse" | "delivery_is_warehouse" | "carrier_amount_cents"> & {
  pickup_warehouse_id: string | null;
  delivery_warehouse_id: string | null;
  order_leg_carrier_terms: Terms | null;
};
type PorterJobRow = Omit<AvailablePorterJobRow, "order_id" | "order_number" | "carrier_amount_cents"> & {
  order_porter_carrier_terms: { carrier_amount_cents: number } | null;
};
type OrderRow = Omit<AvailableJobRow, "order_id" | "vehicle_type_name" | "legs" | "matching_vehicle_ids" | keyof Terms> & {
  id: string;
  service_type: string;
  order_porter_jobs: PorterJobRow | null;
  status: string;
  assigned_at: string | null;
  picked_up_at: string | null;
  in_transit_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  carrier_vehicle_id: string | null;
  vehicle_types: { name_it: string } | null;
  order_legs: LegRow[];
};

/** An own order in the shape of a list_available_jobs row, so the cards are built the same way (toJobCard). */
function asJobRow(o: OrderRow): AvailableJobRow {
  const legs = o.order_legs ?? [];
  const sum = (k: keyof Terms) => legs.reduce((s, l) => s + (l.order_leg_carrier_terms?.[k] ?? 0), 0);
  return {
    ...o,
    order_id: o.id,
    vehicle_type_name: o.vehicle_types?.name_it ?? "—",
    carrier_amount_cents: sum("carrier_amount_cents"),
    transport_carrier_cents: sum("transport_carrier_cents"),
    porters_carrier_cents: sum("porters_carrier_cents"),
    packing_carrier_cents: sum("packing_carrier_cents"),
    matching_vehicle_ids: [],
    legs: legs.map((l) => ({
      leg_index: l.leg_index,
      pickup_city: l.pickup_city,
      pickup_province: l.pickup_province,
      pickup_is_warehouse: !!l.pickup_warehouse_id,
      delivery_city: l.delivery_city,
      delivery_province: l.delivery_province,
      delivery_is_warehouse: !!l.delivery_warehouse_id,
      distance_m: l.distance_m,
      duration_s: l.duration_s,
      pickup_date: l.pickup_date,
      pickup_window_start: l.pickup_window_start,
      pickup_window_end: l.pickup_window_end,
      pickup_floor: l.pickup_floor,
      pickup_has_elevator: l.pickup_has_elevator,
      delivery_floor: l.delivery_floor,
      delivery_has_elevator: l.delivery_has_elevator,
      is_urgent: l.is_urgent,
      porter_package_code: l.porter_package_code,
      porters_count: l.porters_count,
      porters_included_hours: l.porters_included_hours,
      carrier_amount_cents: l.order_leg_carrier_terms?.carrier_amount_cents ?? null,
    })),
  };
}

export type MyJobSummary = JobCard & { status: string; statusLabel: string; tab: MyJobTab; assignedAt: string | null };

/** The card of an own order: transport from its legs, Facchinaggio from its job (D164). */
function cardOf(o: OrderRow): JobCard {
  const j = o.order_porter_jobs;
  if (o.service_type === "porters" && j) {
    const { order_porter_carrier_terms: terms, ...job } = j;
    return toPorterJobCard({ ...job, order_id: o.id, order_number: o.order_number, carrier_amount_cents: terms?.carrier_amount_cents ?? 0 });
  }
  return toJobCard(asJobRow(o));
}

function toSummary(o: OrderRow): MyJobSummary | null {
  const tab = myJobTab(o.status);
  if (!tab) return null; // e.g. refunded after a cancellation: not shown to the carrier
  return { ...cardOf(o), status: o.status, statusLabel: carrierJobStatusLabel(o.status, o.service_type), tab, assignedAt: o.assigned_at };
}

/** The carrier's jobs for "Le mie corse" (all tabs), by pickup time. Also for the overlap warning (D120). */
export async function loadMyJobs(db: SupabaseClient, userId: string): Promise<MyJobSummary[]> {
  const { data, error } = await db
    .from("orders")
    .select(`${MY_JOB_COLUMNS}, order_legs(${LEG_COLUMNS})`)
    .eq("carrier_id", userId)
    .order("pickup_window_start");
  if (error) {
    logDbError("loadMyJobs", error);
    throw new Error("my jobs unavailable");
  }
  return ((data ?? []) as unknown as OrderRow[])
    .map(toSummary)
    .filter((j): j is MyJobSummary => j !== null);
}

export type MyJobLegDetail = {
  legIndex: number;
  pickupAddress: string;
  pickupPostalCode: string | null;
  pickupLat: number;
  pickupLng: number;
  deliveryAddress: string;
  deliveryPostalCode: string | null;
  deliveryLat: number;
  deliveryLng: number;
};

export type MyJobDetail = MyJobSummary & {
  /** Facchinaggio: the full address of the job (after accepting, RLS); null for transport. */
  portersPlace: { address: string; lat: number; lng: number } | null;
  release: ReleaseInfo;
  goodsDescription: string;
  goodsDimensionsNote: string | null;
  customerNotes: string | null;
  pickupContact: { name: string; phone: string };
  deliveryContact: { name: string; phone: string };
  addresses: MyJobLegDetail[];
  vehicle: JobVehicle | null;
  times: { assignedAt: string | null; pickedUpAt: string | null; inTransitAt: string | null; deliveredAt: string | null; completedAt: string | null };
};

/** Full job (addresses, contacts, notes) — only for an order assigned to this carrier; null otherwise. */
export async function loadMyJob(db: SupabaseClient, userId: string, orderId: string, now = new Date()): Promise<MyJobDetail | null> {
  if (!isUuid(orderId)) return null;
  const { data, error } = await db
    .from("orders")
    .select(`${MY_JOB_COLUMNS}, ${PERSONAL_COLUMNS}, order_legs(${LEG_COLUMNS}, ${PERSONAL_LEG_COLUMNS}), porter_place:order_porter_jobs(address, lat, lng)`)
    .eq("id", orderId)
    .eq("carrier_id", userId)
    .maybeSingle();
  if (error) {
    logDbError("loadMyJob", error);
    throw new Error("job unavailable");
  }
  if (!data) return null;
  const o = data as unknown as OrderRow & {
    porter_place: { address: string; lat: number; lng: number } | null;
    goods_description: string;
    goods_dimensions_note: string | null;
    customer_notes: string | null;
    pickup_contact_name: string;
    pickup_contact_phone: string;
    delivery_contact_name: string;
    delivery_contact_phone: string;
    order_legs: (LegRow & {
      pickup_address: string;
      pickup_postal_code: string | null;
      pickup_lat: number;
      pickup_lng: number;
      delivery_address: string;
      delivery_postal_code: string | null;
      delivery_lat: number;
      delivery_lng: number;
    })[];
  };
  const summary = toSummary(o);
  if (!summary) return null;

  let vehicle: JobVehicle | null = null;
  if (o.carrier_vehicle_id) {
    const { data: v } = await db.from("carrier_vehicles").select("id, plate, vehicle_types(name_it)").eq("id", o.carrier_vehicle_id).maybeSingle();
    const row = v as unknown as { id: string; plate: string; vehicle_types: { name_it: string } | null } | null;
    if (row) vehicle = { id: row.id, plate: row.plate, vehicleTypeName: row.vehicle_types?.name_it ?? "—" };
  }

  const legs = [...o.order_legs].sort((a, b) => a.leg_index - b.leg_index);
  return {
    ...summary,
    release: releaseInfo({ status: o.status, assigned_at: o.assigned_at, pickup_window_start: o.pickup_window_start }, now),
    portersPlace: o.porter_place ?? null,
    goodsDescription: o.goods_description,
    goodsDimensionsNote: o.goods_dimensions_note,
    customerNotes: o.customer_notes,
    pickupContact: { name: o.pickup_contact_name, phone: o.pickup_contact_phone },
    deliveryContact: { name: o.delivery_contact_name ?? "", phone: o.delivery_contact_phone ?? "" }, // none for Facchinaggio
    addresses: legs.map((l) => ({
      legIndex: l.leg_index,
      pickupAddress: l.pickup_address,
      pickupPostalCode: l.pickup_postal_code,
      pickupLat: l.pickup_lat,
      pickupLng: l.pickup_lng,
      deliveryAddress: l.delivery_address,
      deliveryPostalCode: l.delivery_postal_code,
      deliveryLat: l.delivery_lat,
      deliveryLng: l.delivery_lng,
    })),
    vehicle,
    times: { assignedAt: o.assigned_at, pickedUpAt: o.picked_up_at, inTransitAt: o.in_transit_at, deliveredAt: o.delivered_at, completedAt: o.completed_at },
  };
}

// ---------------------------------------------------------------------------
// "Accetta la Corsa" and "Rinuncia"
// ---------------------------------------------------------------------------

export type AcceptResult = { ok: true; newlyAssigned: boolean; message: string } | { ok: false; error: string; refreshList: boolean };

/**
 * accept_job with the carrier's session. Only a NEW assignment (newly_assigned) queues the customer e-mail
 * order_assigned; the same carrier accepting again (double click, second tab) gets "already yours" and no e-mail.
 */
export async function acceptJob(db: SupabaseClient, userId: string, orderId: string, vehicleId: string, notify: JobNotifyDeps): Promise<AcceptResult> {
  if (!isUuid(orderId)) return { ok: false, error: JOB_MSG.notFound, refreshList: true };
  if (!isUuid(vehicleId)) return { ok: false, error: JOB_MSG.chooseVehicle, refreshList: false };

  const { data, error } = await db.rpc("accept_job", { p_order_id: orderId, p_vehicle_id: vehicleId });
  if (error) {
    if (error.code !== "55000" && error.code !== "42501" && error.code !== "22023") logDbError("accept_job", error);
    const view = jobDbError("accept", error);
    return { ok: false, error: view.message, refreshList: view.refreshList };
  }
  const outcome = acceptOutcome(data);
  if (!outcome.ok) {
    logDbError("accept_job: unexpected result", null);
    return { ok: false, error: outcome.message, refreshList: true };
  }

  if (outcome.newlyAssigned) {
    try {
      // accept_job returns no order id. The id given to the e-mail is the one read back with the carrier's
      // session AFTER the successful call — an order this carrier is now assigned to — never the raw form value.
      const { data: assigned, error: readError } = await db
        .from("orders")
        .select("id")
        .eq("id", orderId)
        .eq("carrier_id", userId)
        .maybeSingle<{ id: string }>();
      if (readError || !assigned) throw new Error("accepted order not readable with the carrier's session");
      await sendOrderAssignedEmail(notify.serviceDb(), assigned.id, notify.appUrl);
    } catch (e) {
      logMailError("order_assigned", orderId, e);
    }
  }
  return outcome;
}

/** "Accetta" for Facchinaggio (D164): accept_porter_job with the carrier's session — no vehicle. Same e-mail rule. */
export async function acceptPorterJob(db: SupabaseClient, userId: string, orderId: string, notify: JobNotifyDeps): Promise<AcceptResult> {
  if (!isUuid(orderId)) return { ok: false, error: JOB_MSG.notFound, refreshList: true };
  const { data, error } = await db.rpc("accept_porter_job", { p_order_id: orderId });
  if (error) {
    if (error.code !== "55000" && error.code !== "42501" && error.code !== "22023") logDbError("accept_porter_job", error);
    const view = jobDbError("accept", error);
    return { ok: false, error: view.message, refreshList: view.refreshList };
  }
  const outcome = acceptOutcome(data);
  if (!outcome.ok) {
    logDbError("accept_porter_job: unexpected result", null);
    return { ok: false, error: outcome.message, refreshList: true };
  }
  if (outcome.newlyAssigned) {
    try {
      const { data: assigned, error: readError } = await db.from("orders").select("id").eq("id", orderId).eq("carrier_id", userId).maybeSingle<{ id: string }>();
      if (readError || !assigned) throw new Error("accepted order not readable with the carrier's session");
      await sendOrderAssignedEmail(notify.serviceDb(), assigned.id, notify.appUrl);
    } catch (e) {
      logMailError("order_assigned", orderId, e);
    }
  }
  return outcome;
}

/**
 * `tooLate`: release_job refused with too_late (the deadline passed meanwhile) or loaded (the load is on board) —
 * the UI shows "Contatta Transigo".
 */
export type ReleaseResult = { ok: true; message: string } | { ok: false; error: string; tooLate: boolean };

/**
 * release_job with the carrier's session (D121; the database decides the 15 min / 48 h rule). Then one e-mail
 * to the Transigo team per release. The order number, pickup window and acceptance time are read with the
 * carrier's session BEFORE the call — afterwards the order is no longer the carrier's (RLS).
 */
export async function releaseJob(db: SupabaseClient, userId: string, orderId: string, notify: JobNotifyDeps): Promise<ReleaseResult> {
  if (!isUuid(orderId)) return { ok: false, error: JOB_MSG.notAssigned, tooLate: false };

  const { data: before } = await db
    .from("orders")
    .select("order_number, assigned_at, order_legs(leg_index, pickup_window_start, pickup_window_end), order_porter_jobs(window_start, window_end)")
    .eq("id", orderId)
    .eq("carrier_id", userId)
    .maybeSingle();

  const { data, error } = await db.rpc("release_job", { p_order_id: orderId }).single<{ released_at: string; order_number: string }>();
  if (error || !data) {
    if (error?.code !== "55000" && error?.code !== "22023") logDbError("release_job", error);
    const tooLate = error?.code === "55000" && (error.details === "too_late" || error.details === "loaded");
    return { ok: false, error: jobDbError("release", error).message, tooLate };
  }

  try {
    await notifyAdminOfRelease(db, userId, orderId, data, before as ReleaseSnapshot | null, notify);
  } catch (e) {
    logMailError(CARRIER_RELEASED_JOB_TEMPLATE, orderId, e);
  }
  return { ok: true, message: JOB_MSG.released };
}

type ReleaseSnapshot = {
  order_number: string;
  assigned_at: string | null;
  order_legs: { leg_index: number; pickup_window_start: string; pickup_window_end: string }[];
  order_porter_jobs: { window_start: string; window_end: string } | null; // Facchinaggio: the work window
};

async function notifyAdminOfRelease(
  db: SupabaseClient,
  userId: string,
  orderId: string,
  released: { released_at: string; order_number: string },
  before: ReleaseSnapshot | null,
  notify: JobNotifyDeps,
): Promise<void> {
  if (!notify.adminEmail) {
    console.error(`[jobs] ADMIN_NOTIFICATION_EMAIL not set — ${CARRIER_RELEASED_JOB_TEMPLATE} e-mail not queued`, { orderId });
    return;
  }
  const { data: carrier } = await db.from("carriers").select("company_name").eq("profile_id", userId).single();
  const porterJob = before?.order_porter_jobs ?? null;
  const first = porterJob
    ? { pickup_window_start: porterJob.window_start, pickup_window_end: porterJob.window_end }
    : [...(before?.order_legs ?? [])].sort((a, b) => a.leg_index - b.leg_index)[0];
  if (!first) throw new Error("pickup window not read before the release");
  const rendered = renderCarrierReleasedJobEmail({
    orderNumber: released.order_number,
    companyName: carrier?.company_name ?? "—",
    pickupWindowStart: new Date(first.pickup_window_start),
    pickupWindowEnd: new Date(first.pickup_window_end),
    assignedAt: before?.assigned_at ? new Date(before.assigned_at) : null,
    releasedAt: new Date(released.released_at),
    adminOrderUrl: `${notify.appUrl}/admin/ordini/${orderId}`,
  });
  // One e-mail per release (D121, D129): keyed by the order and the release time, so the same order accepted and
  // released again gives a new e-mail.
  await sendEmail(notify.serviceDb(), {
    ...rendered,
    templateCode: CARRIER_RELEASED_JOB_TEMPLATE,
    to: notify.adminEmail,
    orderId,
    eventKey: `released:${new Date(released.released_at).toISOString()}`,
  });
}
