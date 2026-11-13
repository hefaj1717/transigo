import { randomUUID } from "node:crypto";
import { createUser, service, type TestUser } from "./helpers";

// Shared fixtures for the job tests (carrier-jobs, admin-dispatch): active carriers with approved documents and
// vehicles, paid orders created through create_order + the payment functions (as in production).
// LOCAL database only (D64). Call setupJobContext() in beforeAll and teardownJobContext() in afterAll.

export const FUTURE = "2099-12-31";
export const PAST = "2020-01-01";
export const HOUR = 3600_000;

export const plate = () => `TJ${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
export const vat = () => Math.floor(Math.random() * 1e11).toString().padStart(11, "0");
export const check = async <T,>(p: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> => {
  const { data, error } = await p;
  if (error) throw error;
  if (data == null) throw new Error("expected data, got null");
  return data;
};
export const run = async (p: PromiseLike<{ error: unknown }>) => {
  const { error } = await p;
  if (error) throw error;
};
export type DbError = { code?: string; details?: string; message?: string } | null;

let priceList: { id: string; version: number };
let vt: Record<string, string>; // vehicle type code → id
let warehouseId: string;
let admin: TestUser;
let customer: TestUser;

// ---------------------------------------------------------------------------
// Carriers
// ---------------------------------------------------------------------------

export async function doc(c: TestUser, docType: string, extra: Record<string, unknown> = {}) {
  return (await check(c.client.from("carrier_documents").insert({
    carrier_id: c.id, doc_type: docType, storage_path: `${c.id}/${randomUUID()}.pdf`,
    file_name: "doc.pdf", mime_type: "application/pdf", size_bytes: 2048, ...extra,
  }).select("id").single())).id as string;
}

export async function addVehicle(c: TestUser, typeCode: string, extra: Record<string, unknown> = {}): Promise<string> {
  const v = await check(c.client.from("carrier_vehicles").insert({
    carrier_id: c.id, vehicle_type_id: vt[typeCode], plate: plate(), payload_kg: 1000, ...extra,
  }).select("id").single());
  await doc(c, "vehicle_registration", { vehicle_id: v.id, expires_at: FUTURE });
  await doc(c, "insurance_rca", { vehicle_id: v.id, expires_at: FUTURE });
  return v.id as string;
}

/** Submitted and approved by the admin: active, every document and the vehicle approved. */
export async function activeCarrier(typeCode = "van_medium", payloadKg = 1200): Promise<{ user: TestUser; vehicleId: string }> {
  const user = await createUser({ role: "padroncino" });
  await run(service.from("carriers").insert({
    profile_id: user.id, company_name: "Trasporti Corse Srl", vat_number: vat(), fiscal_code: "RSSMRA80A01H501U",
    hq_street: "Via Roma 1", hq_city: "Milano", hq_postal_code: "20100", hq_province: "MI", sdi_code: "M5UXCR1",
  }));
  await doc(user, "transport_license");
  await doc(user, "driving_license", { expires_at: FUTURE });
  const vehicleId = await addVehicle(user, typeCode, { payload_kg: payloadKg });
  await run(user.client.rpc("submit_carrier_for_review"));
  await run(service.rpc("decide_carrier_review", { p_carrier_id: user.id, p_admin_id: admin.id, p_approve: true, p_reason: null }));
  return { user, vehicleId };
}

/** Approves a vehicle added after activation (with its documents). */
export const approveVehicle = (vehicleId: string) => service.rpc("approve_carrier_vehicle", { p_vehicle_id: vehicleId, p_admin_id: admin.id });

// ---------------------------------------------------------------------------
// Paid orders (create_order + payment through the webhook functions, as in production)
// ---------------------------------------------------------------------------

export type OrderOpts = {
  vehicle?: string;
  hoursAhead?: number;
  weightKg?: number | null;
  item?: [number, number, number] | null;
  pallets?: number | null;
  storage?: boolean;
  /** Overrides of leg 0 (e.g. loading / unloading help instead of the package porters, D182). */
  leg0?: Record<string, unknown>;
};

function window(hoursAhead: number, extraHours = 0) {
  const start = new Date(Date.now() + (hoursAhead + extraHours) * HOUR);
  start.setUTCMinutes(0, 0, 0);
  return { pickup_date: start.toISOString().slice(0, 10), pickup_window_start: start.toISOString(), pickup_window_end: new Date(start.getTime() + 2 * HOUR).toISOString() };
}

const leg = (index: number, hoursAhead: number, overrides: Record<string, unknown> = {}) => ({
  leg_index: index,
  pickup_address: "Via Roma 1, 20121 Milano MI", pickup_place_id: "place-pickup", pickup_lat: 45.4642, pickup_lng: 9.19,
  pickup_city: "Milano", pickup_postal_code: "20121", pickup_province: "MI",
  delivery_address: "Via Po 2, 10124 Torino TO", delivery_place_id: "place-delivery", delivery_lat: 45.0703, delivery_lng: 7.6869,
  delivery_city: "Torino", delivery_postal_code: "10124", delivery_province: "TO",
  distance_m: 143_122, duration_s: 5_400, ...window(hoursAhead),
  pickup_floor: 0, pickup_has_elevator: false, delivery_floor: 2, delivery_has_elevator: true, is_urgent: false,
  porter_package_code: "parcels", porters_count: 2, porters_included_hours: 1, porter_overtime_grace_minutes: 15,
  ...overrides,
});

const line = (sort: number, legIndex: number | null, type: string, net: number, vatCents: number, group: string) => ({
  sort_order: sort, leg_index: legIndex, line_type: type, label_it: `Voce ${sort}`, quantity: 1,
  unit_amount_cents: net, net_cents: net, vat_cents: vatCents, gross_cents: net + vatCents, carrier_share_group: group,
});

function payload(o: OrderOpts) {
  const hours = o.hoursAhead ?? 72;
  const base = {
    customer_id: customer.id,
    vehicle_type_id: vt[o.vehicle ?? "van_medium"],
    goods_description: "Divano di Mario Rossi e 5 scatoloni",
    items_count: 6,
    weight_kg: o.weightKg === undefined ? 120 : o.weightKg,
    largest_item_length_cm: o.item?.[0] ?? null,
    largest_item_width_cm: o.item?.[1] ?? null,
    largest_item_height_cm: o.item?.[2] ?? null,
    pallets_count: o.pallets ?? null,
    packing_items_count: 0,
    pickup_contact_name: "Mario Rossi", pickup_contact_phone: "+393331234567",
    delivery_contact_name: "Lucia Bianchi", delivery_contact_phone: "+393337654321",
    customer_notes: "Citofono Rossi, scala B",
    storage: null as Record<string, unknown> | null,
    legs: [leg(0, hours, o.leg0)],
    charges: {
      price_list_id: priceList.id, price_list_version: priceList.version, customer_type: "private", vat_rate_bp: 2200,
      subtotal_cents: 16_000, vat_cents: 3_520, total_cents: 19_520, porter_overtime_rate_cents: 3_500,
      billing_details: { first_name: "Mario", last_name: "Rossi", fiscal_code: "RSSMRA80A01F205X", street: "Via Roma 1", city: "Milano", postal_code: "20121", province: "MI" },
      terms_accepted_at: new Date().toISOString(), terms_version: "2026-11-01", quoted_at: new Date().toISOString(),
    },
    lines: [line(0, 0, "transport", 10_000, 2_200, "transport"), line(1, 0, "porters", 6_000, 1_320, "porters")],
    carrier_terms: [{ leg_index: 0, carrier_amount_cents: 11_800, transport_carrier_cents: 7_000, porters_carrier_cents: 4_800, packing_carrier_cents: 0, porter_share_kind: "percent", porter_share_bp: 8000 }],
  };
  if (!o.storage) return base;
  return {
    ...base,
    storage: { storage_type: "short_term", storage_billing_unit: "pallet_day", storage_days: 5, storage_pallets: 2, warehouse_id: warehouseId },
    legs: [
      leg(0, hours, { delivery_warehouse_id: warehouseId, delivery_address: "Magazzino Transigo", delivery_city: "Milano", delivery_province: "MI" }),
      leg(1, hours, { pickup_warehouse_id: warehouseId, pickup_address: "Magazzino Transigo", ...window(hours, 120), porter_package_code: "parcels", porters_count: 1, porters_included_hours: 1, porter_overtime_grace_minutes: 15 }),
    ],
    charges: { ...base.charges, subtotal_cents: 35_500, vat_cents: 7_810, total_cents: 43_310 },
    lines: [
      line(0, 0, "transport", 10_000, 2_200, "transport"), line(1, 0, "porters", 6_000, 1_320, "porters"),
      line(2, 1, "transport", 10_000, 2_200, "transport"), line(3, 1, "porters", 6_000, 1_320, "porters"),
      line(4, null, "storage", 3_500, 770, "none"),
    ],
    carrier_terms: [
      { leg_index: 0, carrier_amount_cents: 11_800, transport_carrier_cents: 7_000, porters_carrier_cents: 4_800, packing_carrier_cents: 0, porter_share_kind: "percent", porter_share_bp: 8000 },
      { leg_index: 1, carrier_amount_cents: 11_800, transport_carrier_cents: 7_000, porters_carrier_cents: 4_800, packing_carrier_cents: 0, porter_share_kind: "percent", porter_share_bp: 8000 },
    ],
  };
}

export async function paidOrder(o: OrderOpts = {}): Promise<string> {
  const p = payload(o);
  const order = (await check(service.rpc("create_order", { p }))) as { id: string };
  const session = `cs_test_${randomUUID()}`;
  await run(service.rpc("start_order_payment", { p_order_id: order.id, p_session_id: session, p_amount_cents: p.charges.total_cents, p_expires_at: new Date(Date.now() + HOUR).toISOString() }));
  await run(service.rpc("confirm_order_payment", { p_session_id: session, p_payment_intent_id: `pi_${randomUUID()}`, p_charge_id: `ch_${randomUUID()}`, p_amount_cents: p.charges.total_cents, p_currency: "eur" }));
  return order.id;
}

/**
 * An order whose Stripe payment did not match (D96): `amount_mismatch` (Stripe received `receivedDelta` cents more
 * or less) → the order is in payment_review. Returns the order and the payment in review.
 */
export async function reviewOrder(o: OrderOpts & { receivedDelta?: number } = {}): Promise<{ orderId: string; paymentId: string; receivedCents: number }> {
  const p = payload(o);
  const order = (await check(service.rpc("create_order", { p }))) as { id: string };
  const session = `cs_test_${randomUUID()}`;
  const paymentId = (await check(service.rpc("start_order_payment", { p_order_id: order.id, p_session_id: session, p_amount_cents: p.charges.total_cents, p_expires_at: new Date(Date.now() + HOUR).toISOString() }))) as string;
  const receivedCents = p.charges.total_cents + (o.receivedDelta ?? -100);
  await run(service.rpc("confirm_order_payment", { p_session_id: session, p_payment_intent_id: `pi_${randomUUID()}`, p_charge_id: `ch_${randomUUID()}`, p_amount_cents: receivedCents, p_currency: "eur" }));
  return { orderId: order.id, paymentId, receivedCents };
}

export type JobRow = { order_id: string; matching_vehicle_ids: string[]; legs: Record<string, unknown>[]; [k: string]: unknown };
export const list = async (c: TestUser, orderId?: string) => {
  const { data, error } = await c.client.rpc("list_available_jobs", orderId ? { p_order_id: orderId } : {});
  return { rows: (data ?? []) as JobRow[], error: error as DbError };
};
export const listedIds = async (c: TestUser) => {
  const { rows, error } = await list(c);
  if (error) throw error;
  return rows.map((r) => r.order_id);
};
export const accept = (c: TestUser, orderId: string, vehicleId: string) => c.client.rpc("accept_job", { p_order_id: orderId, p_vehicle_id: vehicleId }).single<{ assigned_at: string; newly_assigned: boolean }>();
export const release = (c: TestUser, orderId: string) => c.client.rpc("release_job", { p_order_id: orderId }).single<{ released_at: string; order_number: string }>();
export const orderRow = (id: string) => check(service.from("orders").select("status, carrier_id, carrier_vehicle_id, assigned_at").eq("id", id).single());
export const history = async (id: string) =>
  check(service.from("order_status_history").select("from_status, to_status, changed_by, source").eq("order_id", id).order("id"));


export type JobContext = { admin: TestUser; customer: TestUser; vt: Record<string, string> };

/** Active price list, vehicle types, one active warehouse, an admin and a private customer. */
export async function setupJobContext(): Promise<JobContext> {
  priceList = await check(service.from("price_lists").select("id, version").eq("status", "active").single());
  const types = await check(service.from("vehicle_types").select("id, code"));
  vt = Object.fromEntries(types.map((t) => [t.code, t.id]));
  warehouseId = (await check(service.from("warehouses").insert({
    name: "Magazzino Corse", address: "Via Magazzino 1, Milano", city: "Milano", province: "MI", lat: 45.5, lng: 9.2, is_active: true,
  }).select("id").single())).id;
  [admin, customer] = await Promise.all([createUser({}), createUser({})]);
  await run(service.from("profiles").update({ role: "admin" }).eq("id", admin.id));
  await run(service.from("customers").insert({ profile_id: customer.id, customer_type: "private" }));
  return { admin, customer, vt };
}

/** Paid orders cannot be deleted (on purpose); the local database is reset before every run. */
export async function teardownJobContext() {
  if (warehouseId) await service.from("warehouses").update({ is_active: false }).eq("id", warehouseId);
}
