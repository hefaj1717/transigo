import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";

// Stage 4.2 — available jobs and "Accetta la Corsa" (D21, D22, D29, D87, D116–D121):
// who may list / accept / release, what the list shows (no personal data), vehicle matching, the race between
// carriers (exactly one winner), "Rinuncia" rules, the vehicle lock while on a job.

const FUTURE = "2099-12-31";
const PAST = "2020-01-01";
const HOUR = 3600_000;

const plate = () => `TJ${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const vat = () => Math.floor(Math.random() * 1e11).toString().padStart(11, "0");
const check = async <T,>(p: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> => {
  const { data, error } = await p;
  if (error) throw error;
  if (data == null) throw new Error("expected data, got null");
  return data;
};
const run = async (p: PromiseLike<{ error: unknown }>) => {
  const { error } = await p;
  if (error) throw error;
};
type DbError = { code?: string; details?: string; message?: string } | null;

let priceList: { id: string; version: number };
let vt: Record<string, string>; // vehicle type code → id
let warehouseId: string;
let admin: TestUser;
let customer: TestUser;
const createdOrders: string[] = [];

// ---------------------------------------------------------------------------
// Carriers
// ---------------------------------------------------------------------------

async function doc(c: TestUser, docType: string, extra: Record<string, unknown> = {}) {
  return (await check(c.client.from("carrier_documents").insert({
    carrier_id: c.id, doc_type: docType, storage_path: `${c.id}/${randomUUID()}.pdf`,
    file_name: "doc.pdf", mime_type: "application/pdf", size_bytes: 2048, ...extra,
  }).select("id").single())).id as string;
}

async function addVehicle(c: TestUser, typeCode: string, extra: Record<string, unknown> = {}): Promise<string> {
  const v = await check(c.client.from("carrier_vehicles").insert({
    carrier_id: c.id, vehicle_type_id: vt[typeCode], plate: plate(), payload_kg: 1000, ...extra,
  }).select("id").single());
  await doc(c, "vehicle_registration", { vehicle_id: v.id, expires_at: FUTURE });
  await doc(c, "insurance_rca", { vehicle_id: v.id, expires_at: FUTURE });
  return v.id as string;
}

/** Submitted and approved by the admin: active, every document and the vehicle approved. */
async function activeCarrier(typeCode = "van_medium", payloadKg = 1200): Promise<{ user: TestUser; vehicleId: string }> {
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
const approveVehicle = (vehicleId: string) => service.rpc("approve_carrier_vehicle", { p_vehicle_id: vehicleId, p_admin_id: admin.id });

// ---------------------------------------------------------------------------
// Paid orders (create_order + payment through the webhook functions, as in production)
// ---------------------------------------------------------------------------

type OrderOpts = {
  vehicle?: string;
  hoursAhead?: number;
  weightKg?: number | null;
  item?: [number, number, number] | null;
  pallets?: number | null;
  storage?: boolean;
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
    legs: [leg(0, hours)],
    charges: {
      price_list_id: priceList.id, price_list_version: priceList.version, customer_type: "private", vat_rate_bp: 2200,
      subtotal_cents: 16_000, vat_cents: 3_520, total_cents: 19_520, porter_overtime_rate_cents: 3_500,
      billing_details: { fiscal_code: "RSSMRA80A01F205X", street: "Via Roma 1", city: "Milano", postal_code: "20121", province: "MI" },
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

async function paidOrder(o: OrderOpts = {}): Promise<string> {
  const p = payload(o);
  const order = (await check(service.rpc("create_order", { p }))) as { id: string };
  createdOrders.push(order.id);
  const session = `cs_test_${randomUUID()}`;
  await run(service.rpc("start_order_payment", { p_order_id: order.id, p_session_id: session, p_amount_cents: p.charges.total_cents, p_expires_at: new Date(Date.now() + HOUR).toISOString() }));
  await run(service.rpc("confirm_order_payment", { p_session_id: session, p_payment_intent_id: `pi_${randomUUID()}`, p_charge_id: `ch_${randomUUID()}`, p_amount_cents: p.charges.total_cents, p_currency: "eur" }));
  return order.id;
}

type JobRow = { order_id: string; matching_vehicle_ids: string[]; legs: Record<string, unknown>[]; [k: string]: unknown };
const list = async (c: TestUser, orderId?: string) => {
  const { data, error } = await c.client.rpc("list_available_jobs", orderId ? { p_order_id: orderId } : {});
  return { rows: (data ?? []) as JobRow[], error: error as DbError };
};
const listedIds = async (c: TestUser) => {
  const { rows, error } = await list(c);
  if (error) throw error;
  return rows.map((r) => r.order_id);
};
const accept = (c: TestUser, orderId: string, vehicleId: string) => c.client.rpc("accept_job", { p_order_id: orderId, p_vehicle_id: vehicleId }).single<{ assigned_at: string; newly_assigned: boolean }>();
const release = (c: TestUser, orderId: string) => c.client.rpc("release_job", { p_order_id: orderId }).single<{ released_at: string; order_number: string }>();
const orderRow = (id: string) => check(service.from("orders").select("status, carrier_id, carrier_vehicle_id, assigned_at").eq("id", id).single());
const history = async (id: string) =>
  check(service.from("order_status_history").select("from_status, to_status, changed_by, source").eq("order_id", id).order("id"));

beforeAll(async () => {
  priceList = await check(service.from("price_lists").select("id, version").eq("status", "active").single());
  const types = await check(service.from("vehicle_types").select("id, code"));
  vt = Object.fromEntries(types.map((t) => [t.code, t.id]));
  warehouseId = (await check(service.from("warehouses").insert({
    name: "Magazzino Corse", address: "Via Magazzino 1, Milano", city: "Milano", province: "MI", lat: 45.5, lng: 9.2, is_active: true,
  }).select("id").single())).id;
  [admin, customer] = await Promise.all([createUser({}), createUser({})]);
  await run(service.from("profiles").update({ role: "admin" }).eq("id", admin.id));
  await run(service.from("customers").insert({ profile_id: customer.id, customer_type: "private" }));
});

afterAll(async () => {
  // Local database only (D64). Paid orders cannot be deleted (on purpose); the local database is reset before every run.
  if (warehouseId) await service.from("warehouses").update({ is_active: false }).eq("id", warehouseId);
  await deleteCreatedUsers().catch(() => undefined);
});

// ---------------------------------------------------------------------------

describe("who may list and accept (D21, D116, TODO from step 4)", () => {
  let orderId: string;
  beforeAll(async () => {
    orderId = await paidOrder();
  });

  it("anon has no access at all", async () => {
    for (const [fn, args] of [
      ["list_available_jobs", {}], ["carrier_job_eligibility", {}],
      ["accept_job", { p_order_id: orderId, p_vehicle_id: randomUUID() }], ["release_job", { p_order_id: orderId }],
    ] as const) {
      expect((await anon.rpc(fn, args)).error).not.toBeNull();
    }
  });

  it("cliente and admin are not carriers (42501 not_carrier)", async () => {
    for (const u of [customer, admin]) {
      const { error } = await list(u);
      expect(error).toMatchObject({ code: "42501", details: "not_carrier" });
      expect((await u.client.rpc("accept_job", { p_order_id: orderId, p_vehicle_id: randomUUID() })).error?.code).toBe("42501");
    }
  });

  it("suspended, pending_review (not sent and sent) and rejected: no list, no accept (carrier_not_active)", async () => {
    const suspended = await activeCarrier();
    await run(service.rpc("set_carrier_suspension", { p_carrier_id: suspended.user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "Controllo" }));

    const notSent = await createUser({ role: "padroncino" });
    await run(service.from("carriers").insert({ profile_id: notSent.id, company_name: "Bozza Srl", vat_number: vat() }));
    const notSentVehicle = await addVehicle(notSent, "van_medium");

    const sent = await createUser({ role: "padroncino" });
    await run(service.from("carriers").insert({
      profile_id: sent.id, company_name: "Inviato Srl", vat_number: vat(), fiscal_code: "RSSMRA80A01H501U",
      hq_street: "Via Roma 1", hq_city: "Milano", hq_postal_code: "20100", hq_province: "MI", sdi_code: "M5UXCR1",
    }));
    await doc(sent, "transport_license");
    await doc(sent, "driving_license", { expires_at: FUTURE });
    const sentVehicle = await addVehicle(sent, "van_medium");
    await run(sent.client.rpc("submit_carrier_for_review"));

    const rejected = await createUser({ role: "padroncino" });
    await run(service.from("carriers").insert({ profile_id: rejected.id, company_name: "Rifiutato Srl", vat_number: vat(), status: "rejected", status_reason: "x" }));
    const rejectedVehicle = await addVehicle(rejected, "van_medium");

    for (const [u, vehicleId] of [[suspended.user, suspended.vehicleId], [notSent, notSentVehicle], [sent, sentVehicle], [rejected, rejectedVehicle]] as const) {
      expect((await list(u)).error).toMatchObject({ code: "42501", details: "carrier_not_active" });
      expect((await accept(u, orderId, vehicleId)).error).toMatchObject({ code: "42501", details: "carrier_not_active" });
      expect(await u.client.rpc("carrier_job_eligibility").single()).toMatchObject({ data: { blockers: ["carrier_not_active"] } });
    }
    expect((await orderRow(orderId)).status).toBe("paid");
  });

  it("a blocked carrier profile (is_blocked) gets nothing", async () => {
    const c = await activeCarrier();
    await run(service.from("profiles").update({ is_blocked: true }).eq("id", c.user.id));
    expect((await list(c.user)).error).toMatchObject({ code: "42501", details: "not_carrier" });
    expect((await accept(c.user, orderId, c.vehicleId)).error?.code).toBe("42501");
  });

  it("an expired or only pending company document blocks new jobs (approved + valid required)", async () => {
    const c = await activeCarrier();
    const patente = (await check(service.from("carrier_documents").select("id").eq("carrier_id", c.user.id).eq("doc_type", "driving_license").single())).id;
    await run(service.from("carrier_documents").update({ expires_at: PAST }).eq("id", patente));
    await doc(c.user, "driving_license", { expires_at: FUTURE }); // renewed, still pending
    expect((await list(c.user)).error).toMatchObject({ code: "42501", details: "document:driving_license" });
    expect((await accept(c.user, orderId, c.vehicleId)).error).toMatchObject({ code: "42501", details: "document:driving_license" });
  });

  it("an active carrier with approved documents sees the job", async () => {
    const c = await activeCarrier();
    expect(await listedIds(c.user)).toContain(orderId);
    expect(await c.user.client.rpc("carrier_job_eligibility").single()).toMatchObject({ data: { blockers: [], ready_vehicle_ids: [c.vehicleId] } });
  });
});

describe("what the list shows (D119): no personal data before accepting", () => {
  it("only safe fields; cities, km, minutes, load, services, the carrier amount", async () => {
    const orderId = await paidOrder({ item: [120, 80, 60], pallets: 2 });
    const c = await activeCarrier();
    const { rows, error } = await list(c.user, orderId);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    const job = rows[0];
    expect(Object.keys(job).sort()).toEqual([
      "carrier_amount_cents", "items_count", "largest_item_height_cm", "largest_item_length_cm", "largest_item_width_cm",
      "legs", "load_category", "matching_vehicle_ids", "order_id", "order_number", "packing_carrier_cents", "packing_items_count",
      "pallets_count", "pickup_window_start", "porters_carrier_cents", "storage_days", "storage_type", "transport_carrier_cents",
      "vehicle_type_name", "weight_kg",
    ]);
    expect(Object.keys(job.legs[0]).sort()).toEqual([
      "carrier_amount_cents", "delivery_city", "delivery_floor", "delivery_has_elevator", "delivery_is_warehouse", "delivery_province",
      "distance_m", "duration_s", "is_urgent", "leg_index", "pickup_city", "pickup_date", "pickup_floor", "pickup_has_elevator",
      "pickup_is_warehouse", "pickup_province", "pickup_window_end", "pickup_window_start", "porter_package_code", "porters_count",
      "porters_included_hours",
    ]);
    expect(job).toMatchObject({ carrier_amount_cents: 11_800, transport_carrier_cents: 7_000, porters_carrier_cents: 4_800, weight_kg: 120, pallets_count: 2 });
    expect(job.legs[0]).toMatchObject({ pickup_city: "Milano", delivery_city: "Torino", distance_m: 143_122, duration_s: 5_400 });
    const text = JSON.stringify(job);
    for (const secret of ["Via Roma", "Via Po", "Mario", "Rossi", "Lucia", "+39", "Divano", "Citofono", "45.46", "place-pickup", "19520", "16000"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("before accepting, the carrier cannot read the order through the tables (RLS)", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    for (const table of ["orders", "order_legs", "order_leg_carrier_terms", "order_status_history"]) {
      const { data } = await c.user.client.from(table).select("*").eq(table === "orders" ? "id" : "order_id", orderId);
      expect(data ?? []).toEqual([]);
    }
  });

  it("a storage order: both legs, the warehouse only as a flag and its city", async () => {
    const orderId = await paidOrder({ storage: true });
    const c = await activeCarrier();
    const job = (await list(c.user, orderId)).rows[0];
    expect(job.storage_type).toBe("short_term");
    expect(job.carrier_amount_cents).toBe(23_600);
    expect(job.legs.map((l) => [l.pickup_is_warehouse, l.delivery_is_warehouse])).toEqual([[false, true], [true, false]]);
    expect(JSON.stringify(job)).not.toContain("Magazzino");
  });
});

describe("vehicle matching (D22, D87)", () => {
  it("own type and smaller; bigger types hidden", async () => {
    const small = await paidOrder({ vehicle: "car", weightKg: 50 });
    const same = await paidOrder({ vehicle: "van_medium" });
    const bigger = await paidOrder({ vehicle: "van_large" });
    const c = await activeCarrier("van_medium", 1200);
    const ids = await listedIds(c.user);
    expect(ids).toEqual(expect.arrayContaining([small, same]));
    expect(ids).not.toContain(bigger);
  });

  it("weight over the vehicle's payload, an item that does not fit, too many pallets → hidden", async () => {
    const heavy = await paidOrder({ weightKg: 1300 });
    const long = await paidOrder({ item: [320, 50, 50] }); // van_medium cargo 300 × 170 × 180
    const rotated = await paidOrder({ item: [170, 280, 100] }); // fits with rotation
    const pallets = await paidOrder({ pallets: 5 }); // van_medium takes 4
    const c = await activeCarrier("van_medium", 1200);
    const ids = await listedIds(c.user);
    expect(ids).not.toContain(heavy);
    expect(ids).not.toContain(long);
    expect(ids).toContain(rotated);
    expect(ids).not.toContain(pallets);
  });

  it("the carrier's own payload and dimensions count (bigger own cargo space fits the long item)", async () => {
    const long = await paidOrder({ item: [320, 50, 50], weightKg: 900 });
    const c = await activeCarrier("van_medium", 800);
    expect(await listedIds(c.user)).not.toContain(long); // 900 kg > own 800 kg
    const v2 = await addVehicle(c.user, "van_medium", { payload_kg: 1100, cargo_length_cm: 340, cargo_width_cm: 170, cargo_height_cm: 180 });
    await run(approveVehicle(v2));
    const job = (await list(c.user, long)).rows[0];
    expect(job.matching_vehicle_ids).toEqual([v2]);
  });

  it("a vehicle not approved, deactivated or with an expired / only pending RCA does not count", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier("car", 400); // too small for the order
    const pending = await addVehicle(c.user, "van_medium", { payload_kg: 1200 }); // not approved yet
    expect(await listedIds(c.user)).not.toContain(orderId);
    await run(approveVehicle(pending));
    expect(await listedIds(c.user)).toContain(orderId);

    const rca = (await check(service.from("carrier_documents").select("id").eq("vehicle_id", pending).eq("doc_type", "insurance_rca").single())).id;
    await run(service.from("carrier_documents").update({ expires_at: PAST }).eq("id", rca));
    await doc(c.user, "insurance_rca", { vehicle_id: pending, expires_at: FUTURE }); // renewed, pending
    expect(await listedIds(c.user)).not.toContain(orderId);
    expect((await accept(c.user, orderId, pending)).error).toMatchObject({ code: "55000", details: "vehicle_not_ready" });
  });
});

describe("accept_job (D120)", () => {
  it("assigns; history paid → assigned; the carrier now reads the full order (contacts) and its amounts", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    const res = await accept(c.user, orderId, c.vehicleId);
    expect(res.error).toBeNull();
    expect(res.data?.newly_assigned).toBe(true);
    expect(await orderRow(orderId)).toMatchObject({ status: "assigned", carrier_id: c.user.id, carrier_vehicle_id: c.vehicleId });
    expect(await history(orderId)).toEqual(expect.arrayContaining([{ from_status: "paid", to_status: "assigned", changed_by: c.user.id, source: "carrier_app" }]));

    const full = await check(c.user.client.from("orders").select("pickup_contact_name, pickup_contact_phone, goods_description").eq("id", orderId).single());
    expect(full).toEqual({ pickup_contact_name: "Mario Rossi", pickup_contact_phone: "+393331234567", goods_description: "Divano di Mario Rossi e 5 scatoloni" });
    expect((await check(c.user.client.from("order_legs").select("pickup_address").eq("order_id", orderId)))[0].pickup_address).toBe("Via Roma 1, 20121 Milano MI");
    expect(await check(c.user.client.from("order_charges").select("total_cents").eq("order_id", orderId))).toEqual([]); // D29
  });

  it("a double click by the same carrier changes nothing (one history entry)", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    const [a, b] = await Promise.all([accept(c.user, orderId, c.vehicleId), accept(c.user, orderId, c.vehicleId)]);
    expect([a.error, b.error]).toEqual([null, null]);
    expect([a.data?.newly_assigned, b.data?.newly_assigned].sort()).toEqual([false, true]);
    expect((await history(orderId)).filter((h) => h.to_status === "assigned")).toHaveLength(1);
  });

  it("the job disappears from other carriers' lists; they get already_taken", async () => {
    const orderId = await paidOrder();
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    await run(accept(a.user, orderId, a.vehicleId));
    expect(await listedIds(b.user)).not.toContain(orderId);
    expect((await accept(b.user, orderId, b.vehicleId)).error).toMatchObject({ code: "55000", details: "already_taken" });
  });

  it("someone else's vehicle → 22023; a vehicle too small → vehicle_not_suitable; unknown order → 22023", async () => {
    const orderId = await paidOrder();
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    expect((await accept(a.user, orderId, b.vehicleId)).error).toMatchObject({ code: "22023", details: "vehicle" });
    const car = await addVehicle(a.user, "car", { payload_kg: 400 });
    await run(approveVehicle(car));
    expect((await accept(a.user, orderId, car)).error).toMatchObject({ code: "55000", details: "vehicle_not_suitable" });
    expect((await accept(a.user, randomUUID(), a.vehicleId)).error).toMatchObject({ code: "22023", details: "order" });
    expect((await orderRow(orderId)).status).toBe("paid");
  });

  it("the carrier still cannot write the order directly", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await c.user.client.from("orders").update({ status: "assigned", carrier_id: c.user.id }).eq("id", orderId);
    expect(await orderRow(orderId)).toMatchObject({ status: "paid", carrier_id: null });
  });
});

describe("race: carriers accepting at the same time (D120)", () => {
  for (const n of [2, 5]) {
    it(`${n} carriers in parallel → exactly one wins, the others get already_taken`, async () => {
      const orderId = await paidOrder();
      const carriers = await Promise.all(Array.from({ length: n }, () => activeCarrier()));
      const results = await Promise.all(carriers.map((c) => accept(c.user, orderId, c.vehicleId)));
      const winners = results.filter((r) => r.error === null);
      const losers = results.filter((r) => r.error !== null);
      expect(winners).toHaveLength(1);
      expect(losers.map((r) => (r.error as DbError)?.details)).toEqual(Array(n - 1).fill("already_taken"));
      const winner = carriers[results.findIndex((r) => r.error === null)];
      expect(await orderRow(orderId)).toMatchObject({ status: "assigned", carrier_id: winner.user.id, carrier_vehicle_id: winner.vehicleId });
      expect((await history(orderId)).filter((h) => h.to_status === "assigned")).toHaveLength(1);
    });
  }
});

describe("release_job — Rinuncia (D121)", () => {
  const ageAssignment = (orderId: string, minutes: number) =>
    run(service.from("orders").update({ assigned_at: new Date(Date.now() - minutes * 60_000).toISOString() }).eq("id", orderId));

  it("within 15 minutes of accepting: back to paid and to the list; history assigned → paid", async () => {
    const orderId = await paidOrder({ hoursAhead: 6 });
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    await run(accept(a.user, orderId, a.vehicleId));
    const res = await release(a.user, orderId);
    expect(res.error).toBeNull();
    expect(res.data?.order_number).toMatch(/^TG-/);
    expect(await orderRow(orderId)).toMatchObject({ status: "paid", carrier_id: null, carrier_vehicle_id: null, assigned_at: null });
    expect((await history(orderId)).at(-1)).toEqual({ from_status: "assigned", to_status: "paid", changed_by: a.user.id, source: "carrier_app" });
    expect(await listedIds(b.user)).toContain(orderId);
    expect((await accept(b.user, orderId, b.vehicleId)).error).toBeNull();
  });

  it("after 15 minutes and less than 48 h before pickup: too_late", async () => {
    const orderId = await paidOrder({ hoursAhead: 30 });
    const c = await activeCarrier();
    await run(accept(c.user, orderId, c.vehicleId));
    await ageAssignment(orderId, 16);
    expect((await release(c.user, orderId)).error).toMatchObject({ code: "55000", details: "too_late" });
    expect((await orderRow(orderId)).status).toBe("assigned");
  });

  it("after 15 minutes but 48 h or more before pickup: allowed", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    const c = await activeCarrier();
    await run(accept(c.user, orderId, c.vehicleId));
    await ageAssignment(orderId, 60);
    expect((await release(c.user, orderId)).error).toBeNull();
  });

  it("only the assigned carrier, only in status assigned", async () => {
    const orderId = await paidOrder();
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    expect((await release(a.user, orderId)).error).toMatchObject({ code: "55000", details: "not_assigned" }); // not accepted yet
    await run(accept(a.user, orderId, a.vehicleId));
    expect((await release(b.user, orderId)).error).toMatchObject({ code: "55000", details: "not_assigned" });
    expect((await customer.client.rpc("release_job", { p_order_id: orderId })).error?.code).toBe("42501");
  });

  it("a suspended carrier keeps the job (reads it) and may release it under the same rules (D116)", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await run(accept(c.user, orderId, c.vehicleId));
    await run(service.rpc("set_carrier_suspension", { p_carrier_id: c.user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "Controllo" }));
    expect((await check(c.user.client.from("orders").select("id").eq("id", orderId))).map((o) => o.id)).toEqual([orderId]);
    expect((await release(c.user, orderId)).error).toBeNull();
  });
});

describe("vehicle on a job cannot be deactivated or change type / payload (every role)", () => {
  it("assigned: carrier and service role refused; cargo dimensions still editable; free again after release", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await run(accept(c.user, orderId, c.vehicleId));

    for (const change of [{ is_active: false }, { payload_kg: 1500 }, { vehicle_type_id: vt.van_large }]) {
      expect((await c.user.client.from("carrier_vehicles").update(change).eq("id", c.vehicleId)).error?.code).toBe("55000");
      expect((await service.from("carrier_vehicles").update(change).eq("id", c.vehicleId)).error?.code).toBe("55000");
    }
    expect((await c.user.client.from("carrier_vehicles").update({ cargo_length_cm: 290 }).eq("id", c.vehicleId)).error).toBeNull();

    await run(release(c.user, orderId));
    expect((await c.user.client.from("carrier_vehicles").update({ is_active: false }).eq("id", c.vehicleId)).error).toBeNull();
  });
});
