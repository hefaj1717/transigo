import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, localSql, service, type TestUser } from "./helpers";
import { HOUR, accept, activeCarrier, check, listedIds, paidOrder, run, setupJobContext, teardownJobContext, vat, type DbError } from "./job-fixtures";

// Three services, migration 2a (D151–D157): create_service_order (Facchinaggio, Deposito), warehouse capacity,
// visibility of the new tables per role, porters/storage orders invisible to carrier dispatch until step 6.
// LOCAL database only (D64).

let admin: TestUser;
let customer: TestUser; // private
let business: TestUser;
let otherCustomer: TestUser;
let draftList: { id: string; version: number }; // clone of the active list: boxes S/M/L, minimum 2 h / 2 persons
let warehouseId: string; // 1 box S, 0 others, 10 pallet places — tests that need other numbers make their own

const AREA = "FI"; // activated for this file only
const OUTSIDE = "PA";

const romeDate = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date(Date.now() + offsetDays * 24 * HOUR));

const line = (sort: number, legIndex: number | null, type: string, net: number, group: string) => {
  const vatCents = Math.round((net * 22) / 100);
  return { sort_order: sort, leg_index: legIndex, line_type: type, label_it: `Voce ${sort}`, quantity: 1, unit_amount_cents: net, net_cents: net, vat_cents: vatCents, gross_cents: net + vatCents, carrier_share_group: group };
};
type Line = ReturnType<typeof line>;

const charges = (lines: Line[], customerType: "private" | "business" = "private") => {
  const net = lines.reduce((s, l) => s + l.net_cents, 0);
  const vatCents = lines.reduce((s, l) => s + l.vat_cents, 0);
  return {
    price_list_id: draftList.id, price_list_version: draftList.version, customer_type: customerType, vat_rate_bp: 2200,
    subtotal_cents: net, vat_cents: vatCents, total_cents: net + vatCents, porter_overtime_rate_cents: 3_500,
    billing_details: { first_name: "Mario", last_name: "Rossi", fiscal_code: "RSSMRA80A01F205X", street: "Via Roma 1", city: "Firenze", postal_code: "50123", province: "FI" },
    terms_accepted_at: new Date().toISOString(), terms_version: "2026-11-01", quoted_at: new Date().toISOString(),
  };
};

type JobOpts = { persons?: number; requested?: number; billed?: number; floor?: number; elevator?: boolean; province?: string; hoursAhead?: number };

function portersPayload(o: JobOpts = {}, extra: { lines?: Line[]; chargesPatch?: Record<string, unknown>; customerId?: string } = {}) {
  const start = new Date(Date.now() + (o.hoursAhead ?? 72) * HOUR);
  start.setUTCMinutes(0, 0, 0);
  const persons = o.persons ?? 2;
  const requested = o.requested ?? 2;
  const billed = o.billed ?? Math.max(requested, 2);
  const floor = o.floor ?? 3;
  const elevator = o.elevator ?? false;
  const lines = extra.lines ?? [
    line(0, 0, "porters", persons * billed * 3_000, "porters"),
    ...(floor > 0 && !elevator ? [line(1, 0, "porters_floors", floor * 1_000, "porters")] : []),
  ];
  return {
    service_type: "porters",
    customer_id: extra.customerId ?? customer.id,
    goods_description: "Armadio e 10 scatoloni dal 3° piano",
    customer_notes: "Citofono Rossi",
    site_contact_name: "Mario Rossi", site_contact_phone: "+393331234567",
    porter_job: {
      address: "Via de' Tornabuoni 1, 50123 Firenze FI", place_id: "place-porters", lat: 43.7710, lng: 11.2510,
      city: "Firenze", postal_code: "50123", province: o.province ?? AREA,
      job_date: start.toISOString().slice(0, 10), window_start: start.toISOString(), window_end: new Date(start.getTime() + 2 * HOUR).toISOString(),
      floor, has_elevator: elevator, persons, requested_hours: requested, billed_hours: billed, is_urgent: false, overtime_grace_minutes: 15,
    },
    charges: { ...charges(lines), ...extra.chargesPatch },
    lines,
    porter_terms: { carrier_amount_cents: 9_600, porter_share_kind: "percent", porter_share_bp: 8000, porter_share_carrier_cents: null, porter_share_net_cents: null },
  };
}

type BookingOpts = { unit?: "box" | "pallet"; box?: string; pallets?: number; start?: string; end?: string; intake?: string; outbound?: string; plan?: string; warehouse?: string };

function storagePayload(o: BookingOpts = {}, customerType: "private" | "business" = o.unit === "pallet" ? "business" : "private", customerId?: string) {
  const unit = o.unit ?? "box";
  const lines = [line(0, null, "storage", 6_000, "none")];
  return {
    service_type: "storage",
    customer_id: customerId ?? (customerType === "business" ? business.id : customer.id),
    goods_description: "Mobili del soggiorno",
    customer_notes: null,
    booking: {
      warehouse_id: o.warehouse ?? warehouseId, unit,
      box_code: unit === "box" ? (o.box ?? "s") : null, pallets: unit === "pallet" ? (o.pallets ?? 2) : null,
      start_date: o.start ?? romeDate(2), end_date: o.end ?? romeDate(31),
      payment_plan: o.plan ?? "upfront", intake: o.intake ?? "self", outbound: o.outbound ?? "self",
    },
    charges: charges(lines, customerType),
    lines,
  };
}

const create = (p: unknown) => service.rpc("create_service_order", { p });
const created = async (p: unknown) => (await check(create(p))) as { id: string; order_number: string };
const refused = async (p: unknown, code = "22023", reason?: RegExp) => {
  const { error } = await create(p);
  expect((error as DbError)?.code, (error as DbError)?.message).toBe(code);
  if (reason) expect((error as DbError)?.message).toMatch(reason);
};
const MIN = /price list minimum/, AREA_ERR = /service area/, PAST = /future|past/, LINES = /porter lines/, TOTALS = /line totals/;

async function pay(orderId: string) {
  const total = (await check(service.from("order_charges").select("total_cents").eq("order_id", orderId).single())).total_cents as number;
  const session = `cs_test_${randomUUID()}`;
  await run(service.rpc("start_order_payment", { p_order_id: orderId, p_session_id: session, p_amount_cents: total, p_expires_at: new Date(Date.now() + HOUR).toISOString() }));
  await run(service.rpc("confirm_order_payment", { p_session_id: session, p_payment_intent_id: `pi_${randomUUID()}`, p_charge_id: `ch_${randomUUID()}`, p_amount_cents: total, p_currency: "eur" }));
}

const sql = (s: string) => {
  const res = localSql(s);
  if (!res.ok) throw new Error(res.output);
  return res.output;
};
/** Test-only state changes the API cannot make (triggers off, CHECK constraints still on). */
const force = (s: string) => sql(`set session_replication_role = replica; ${s}`);

const freeUnits = async (warehouse: string, unit: "box" | "pallet", box: string | null, start: string, end: string) =>
  (await check(service.rpc("warehouse_free_units", { p_warehouse_id: warehouse, p_unit: unit, p_box_code: box, p_start: start, p_end: end }))) as number;

// A fresh active warehouse per test; by default the others are switched off (D178 allows many active ones).
async function newWarehouse(boxes: Record<string, number>, pallets = 0, keepOthers = false): Promise<string> {
  if (!keepOthers) await run(service.from("warehouses").update({ is_active: false }).eq("is_active", true));
  const id = (await check(service.from("warehouses").insert({
    name: `Magazzino ${randomUUID().slice(0, 4)}`, address: "Via Magazzino 2, Firenze", city: "Firenze", province: "FI", lat: 43.8, lng: 11.2, is_active: true, pallet_capacity: pallets,
  }).select("id").single())).id as string;
  const rows = Object.entries(boxes).map(([box_code, quantity]) => ({ warehouse_id: id, box_code, quantity }));
  if (rows.length) await run(admin.client.from("warehouse_box_capacity").insert(rows));
  return id;
}

beforeAll(async () => {
  ({ admin, customer } = await setupJobContext());
  [business, otherCustomer] = await Promise.all([createUser({}), createUser({})]);
  await run(service.from("customers").insert([
    { profile_id: business.id, customer_type: "business", company_name: "Delta Srl", vat_number: vat(), sdi_code: "M5UXCR1" },
    { profile_id: otherCustomer.id, customer_type: "private" },
  ]));
  const activeId = (await check(service.from("price_lists").select("id").eq("status", "active").single())).id as string;
  const draftId = (await check(admin.client.rpc("clone_price_list", { p_source_id: activeId }))) as string;
  draftList = await check(service.from("price_lists").select("id, version").eq("id", draftId).single());
  await run(service.from("service_area_provinces").update({ is_active: true }).eq("province_code", AREA));
  await run(service.from("service_area_provinces").update({ is_active: false }).eq("province_code", OUTSIDE));
  warehouseId = await newWarehouse({ s: 1 }, 10);
});

afterAll(async () => {
  await service.from("service_area_provinces").update({ is_active: false }).eq("province_code", AREA);
  await service.from("warehouses").update({ is_active: false }).neq("name", "");
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("create_service_order: who may call it", () => {
  it("only the server (service role): anon, cliente, padroncino and admin are refused", async () => {
    const carrier = await activeCarrier();
    for (const client of [anon, customer.client, carrier.user.client, admin.client]) {
      expect((await client.rpc("create_service_order", { p: portersPayload() })).error).not.toBeNull();
      expect((await client.rpc("warehouse_free_units", { p_warehouse_id: warehouseId, p_unit: "box", p_box_code: "s", p_start: romeDate(1), p_end: romeDate(2) })).error).not.toBeNull();
    }
  });

  it("transport is refused (create_order stays the only way); transport orders have service_type = transport", async () => {
    await refused({ ...portersPayload(), service_type: "transport" }, "22023", /porters or storage/);
    const orderId = await paidOrder();
    expect((await check(service.from("orders").select("service_type, parent_order_id").eq("id", orderId).single()))).toEqual({ service_type: "transport", parent_order_id: null });
  });
});

describe("porters (Facchinaggio)", () => {
  it("creates the order, the job, the carrier terms and the snapshot", async () => {
    const o = await created(portersPayload());
    expect(o.order_number).toBeTruthy();
    expect(await check(service.from("orders").select("service_type, status, vehicle_type_id, pickup_contact_name, delivery_contact_name, carrier_id").eq("id", o.id).single()))
      .toEqual({ service_type: "porters", status: "pending_payment", vehicle_type_id: null, pickup_contact_name: "Mario Rossi", delivery_contact_name: null, carrier_id: null });
    expect(await check(service.from("order_porter_jobs").select("province, persons, requested_hours, billed_hours, floor, has_elevator").eq("order_id", o.id).single()))
      .toEqual({ province: AREA, persons: 2, requested_hours: 2, billed_hours: 2, floor: 3, has_elevator: false });
    expect((await check(service.from("order_porter_carrier_terms").select("carrier_amount_cents").eq("order_id", o.id).single())).carrier_amount_cents).toBe(9_600);
    expect((await check(service.from("order_legs").select("leg_index").eq("order_id", o.id))).length).toBe(0);
    await pay(o.id);
    expect((await check(service.from("orders").select("status").eq("id", o.id).single())).status).toBe("paid");
  });

  it("minimums of the price list (D157): fewer persons or billed hours below the minimum are refused", async () => {
    await refused(portersPayload({ persons: 1 }), "22023", MIN); // the column allows 1 (D177), this price list asks for 2
    await refused(portersPayload({ requested: 1, billed: 1 }), "22023", MIN);
    await refused(portersPayload({ requested: 3, billed: 2 }), "22023", MIN);
    await created(portersPayload({ requested: 1, billed: 2 })); // billed = max(requested, minimum)
  });

  it("province outside the service area, start in the past", async () => {
    await refused(portersPayload({ province: OUTSIDE }), "22023", AREA_ERR);
    await refused(portersPayload({ hoursAhead: -2 }), "22023", PAST);
  });

  it("lines must match the job", async () => {
    const base = portersPayload();
    // a transport line, a line on leg 1, a wrong carrier group, no porters line, two porters lines
    for (const lines of [
      [...base.lines, line(5, 0, "transport", 1_000, "transport")],
      [line(0, 1, "porters", 12_000, "porters")],
      [line(0, 0, "porters", 12_000, "transport")],
      [line(0, 0, "porters_floors", 3_000, "porters")],
      [line(0, 0, "porters", 6_000, "porters"), line(1, 0, "porters", 6_000, "porters")],
      [line(0, null, "storage", 6_000, "none")],
    ]) {
      await refused(portersPayload({}, { lines }), "22023", LINES);
    }
  });

  it("a porters_floors line only for a floor without elevator", async () => {
    const lines = [line(0, 0, "porters", 12_000, "porters"), line(1, 0, "porters_floors", 3_000, "porters")];
    await refused(portersPayload({ floor: 3, elevator: true }, { lines }), "22023", LINES);
    await refused(portersPayload({ floor: 0, elevator: false }, { lines }), "22023", LINES);
    await created(portersPayload({ floor: 3, elevator: false }, { lines }));
    await created(portersPayload({ floor: 0, elevator: false }, { lines: [line(0, 0, "porters", 12_000, "porters")] }));
  });

  it("the sum of the lines must equal the charges", async () => {
    // default lines: 12 000 + 3 000 net, 2 640 + 660 VAT; each patch keeps subtotal + VAT = total (CHECK of order_charges)
    await refused(portersPayload({}, { chargesPatch: { subtotal_cents: 20_000, total_cents: 23_300 } }), "22023", TOTALS);
    await refused(portersPayload({}, { chargesPatch: { vat_cents: 1, total_cents: 15_001 } }), "22023", TOTALS);
    await refused(portersPayload({}, { lines: [] }), "22023", TOTALS);
  });

  it("payload shape: porters without porter_job / porter_terms, with a booking, a blocked or non-customer user", async () => {
    const { porter_terms: _t, ...noTerms } = portersPayload();
    await refused(noTerms);
    await refused({ ...portersPayload(), porter_job: null });
    await refused({ ...portersPayload(), booking: storagePayload().booking });
    await refused(portersPayload({}, { customerId: admin.id }));
    const blocked = await createUser({});
    await run(service.from("customers").insert({ profile_id: blocked.id, customer_type: "private" }));
    await run(service.from("profiles").update({ is_blocked: true }).eq("id", blocked.id));
    await refused(portersPayload({}, { customerId: blocked.id }));
  });
});

describe("storage (Deposito)", () => {
  it("creates the order and the booking (box for a private customer, pallets for a business)", async () => {
    const w = await newWarehouse({ m: 2 }, 5);
    const box = await created(storagePayload({ box: "m", warehouse: w }));
    expect(await check(service.from("orders").select("service_type, status, vehicle_type_id, pickup_contact_name, carrier_id").eq("id", box.id).single()))
      .toEqual({ service_type: "storage", status: "pending_payment", vehicle_type_id: null, pickup_contact_name: null, carrier_id: null });
    expect(await check(service.from("warehouse_bookings").select("unit, box_code, pallets, intake, outbound, payment_plan, status").eq("order_id", box.id).single()))
      .toEqual({ unit: "box", box_code: "m", pallets: null, intake: "self", outbound: "self", payment_plan: "upfront", status: "booked" });
    const pal = await created(storagePayload({ unit: "pallet", pallets: 3, warehouse: w, outbound: "later" }));
    expect((await check(service.from("warehouse_bookings").select("pallets, outbound").eq("order_id", pal.id).single()))).toEqual({ pallets: 3, outbound: "later" });
    await pay(box.id);
  });

  it("box only for private customers, pallets only for businesses (D154)", async () => {
    await refused(storagePayload({ unit: "box" }, "business"), "22023", /D154/);
    await refused(storagePayload({ unit: "pallet" }, "private"), "22023", /D154/);
  });

  it("box not offered by the price list, disabled box", async () => {
    await refused(storagePayload({ box: "xl" }), "22023", /not offered/);
    const w = await newWarehouse({ l: 5 });
    await run(admin.client.from("price_list_storage_boxes").update({ is_enabled: false }).eq("price_list_id", draftList.id).eq("code", "l"));
    try {
      await refused(storagePayload({ box: "l", warehouse: w }), "22023", /not offered/);
    } finally {
      await run(admin.client.from("price_list_storage_boxes").update({ is_enabled: true }).eq("price_list_id", draftList.id).eq("code", "l"));
    }
  });

  it("start in the past, end before start", async () => {
    await refused(storagePayload({ start: romeDate(-1), end: romeDate(10) }), "22023", PAST);
    await refused(storagePayload({ start: romeDate(5), end: romeDate(4) }));
  });

  it("intake or outbound by Transigo need their transport (chain: storage-chain.test.ts); monthly plan not yet (step 10)", async () => {
    await refused(storagePayload({ intake: "transigo" }), "22023", /need their transport/);
    await refused(storagePayload({ outbound: "transigo" }), "22023", /need their transport/);
    await refused(storagePayload({ plan: "monthly", end: romeDate(120) }), "22023", /not available yet/);
  });

  it("inactive or unknown warehouse", async () => {
    const w = await newWarehouse({ s: 3 });
    await run(service.from("warehouses").update({ is_active: false }).eq("id", w));
    await refused(storagePayload({ warehouse: w }), "22023", /warehouse not found/);
    await refused(storagePayload({ warehouse: randomUUID() }), "22023", /warehouse not found/);
  });
});

describe("capacity (D156)", () => {
  it("no free unit → 23P01; only overlapping periods count; pallets add up", async () => {
    const w = await newWarehouse({ s: 1 }, 4);
    await created(storagePayload({ warehouse: w, start: romeDate(10), end: romeDate(20) }));
    await refused(storagePayload({ warehouse: w, start: romeDate(20), end: romeDate(25) }), "23P01"); // last day overlaps
    await created(storagePayload({ warehouse: w, start: romeDate(21), end: romeDate(25) }));
    await created(storagePayload({ warehouse: w, start: romeDate(2), end: romeDate(9) }));
    await refused(storagePayload({ warehouse: w, box: "m" }), "23P01"); // no M boxes at all

    await created(storagePayload({ unit: "pallet", pallets: 3, warehouse: w, start: romeDate(10), end: romeDate(20) }));
    await refused(storagePayload({ unit: "pallet", pallets: 2, warehouse: w, start: romeDate(15), end: romeDate(30) }), "23P01");
    await created(storagePayload({ unit: "pallet", pallets: 1, warehouse: w, start: romeDate(15), end: romeDate(30) }));
    expect(await freeUnits(w, "pallet", null, romeDate(10), romeDate(30))).toBe(0);
    expect(await freeUnits(w, "pallet", null, romeDate(21), romeDate(30))).toBe(3);
  });

  it("D178: two active warehouses at once — each has its own capacity; an inactive one is refused", async () => {
    const a = await newWarehouse({ s: 1 });
    const b = await newWarehouse({ s: 1 }, 0, true);
    expect((await check(service.from("warehouses").select("id").in("id", [a, b]).eq("is_active", true))).length).toBe(2);
    await created(storagePayload({ warehouse: a }));
    await refused(storagePayload({ warehouse: a }), "23P01"); // a is full
    expect(await freeUnits(b, "box", "s", romeDate(2), romeDate(31))).toBe(1); // b is not affected
    const inB = await created(storagePayload({ warehouse: b }));
    expect((await check(service.from("warehouse_bookings").select("warehouse_id").eq("order_id", inB.id).single())).warehouse_id).toBe(b);
    await run(service.from("warehouses").update({ is_active: false }).eq("id", b));
    expect((await create(storagePayload({ warehouse: b }))).error).not.toBeNull();
  });

  it("race for the last box: parallel calls → exactly one succeeds, the rest get 23P01", async () => {
    for (let round = 0; round < 3; round++) {
      const w = await newWarehouse({ s: 1 });
      const results = await Promise.all(Array.from({ length: 6 }, () => create(storagePayload({ warehouse: w }))));
      expect(results.filter((r) => r.error == null)).toHaveLength(1);
      expect(results.filter((r) => r.error != null).map((r) => (r.error as DbError)?.code)).toEqual(Array(5).fill("23P01"));
      expect((await check(service.from("warehouse_bookings").select("id").eq("warehouse_id", w))).length).toBe(1);
    }
  });

  it("unpaid after payment_due_at, expired and cancelled orders do not occupy", async () => {
    const w = await newWarehouse({ s: 1 });
    const unpaid = await created(storagePayload({ warehouse: w }));
    expect(await freeUnits(w, "box", "s", romeDate(2), romeDate(31))).toBe(0);
    force(`update public.orders set payment_due_at = now() - interval '1 minute' where id = '${unpaid.id}';`);
    expect(await freeUnits(w, "box", "s", romeDate(2), romeDate(31))).toBe(1);

    const expired = await created(storagePayload({ warehouse: w }));
    force(`update public.orders set status = 'expired' where id = '${expired.id}';`);
    const cancelled = await created(storagePayload({ warehouse: w }));
    force(`update public.orders set status = 'cancelled', cancelled_at = now() where id = '${cancelled.id}';`);
    expect(await freeUnits(w, "box", "s", romeDate(2), romeDate(31))).toBe(1);

    const paid = await created(storagePayload({ warehouse: w }));
    await pay(paid.id);
    expect(await freeUnits(w, "box", "s", romeDate(2), romeDate(31))).toBe(0);
    await refused(storagePayload({ warehouse: w }), "23P01");
  });

  it("a booking cancelled in warehouse_bookings does not occupy; goods in storage after end_date still do", async () => {
    const w = await newWarehouse({ s: 1 });
    const a = await created(storagePayload({ warehouse: w, start: romeDate(1), end: romeDate(3) }));
    await pay(a.id);
    force(`update public.warehouse_bookings set status = 'cancelled' where order_id = '${a.id}';`);
    expect(await freeUnits(w, "box", "s", romeDate(1), romeDate(3))).toBe(1);

    const b = await created(storagePayload({ warehouse: w, start: romeDate(1), end: romeDate(3) }));
    await pay(b.id);
    // the period is over (dates moved into the past), but the goods were never collected
    force(`update public.warehouse_bookings set start_date = current_date - 20, end_date = current_date - 2, status = 'in_storage' where order_id = '${b.id}';`);
    expect(await freeUnits(w, "box", "s", romeDate(0), romeDate(10))).toBe(0);
    await refused(storagePayload({ warehouse: w, start: romeDate(0), end: romeDate(10) }), "23P01");
    // the same booking, still "booked" (never brought in) → its past period frees the box
    force(`update public.warehouse_bookings set status = 'booked' where order_id = '${b.id}';`);
    expect(await freeUnits(w, "box", "s", romeDate(0), romeDate(10))).toBe(1);
    // released → free
    force(`update public.warehouse_bookings set status = 'released' where order_id = '${b.id}';`);
    expect(await freeUnits(w, "box", "s", romeDate(0), romeDate(10))).toBe(1);
  });
});

describe("visibility", () => {
  let portersId: string;
  let storageId: string;
  let assigned: Awaited<ReturnType<typeof activeCarrier>>;
  let otherCarrier: Awaited<ReturnType<typeof activeCarrier>>;

  beforeAll(async () => {
    portersId = (await created(portersPayload())).id;
    await pay(portersId);
    const w = await newWarehouse({ s: 1 });
    storageId = (await created(storagePayload({ warehouse: w }))).id;
    await pay(storageId);
    [assigned, otherCarrier] = await Promise.all([activeCarrier(), activeCarrier()]);
    // Dispatching porters jobs comes with step 6; here the assignment is set directly.
    force(`update public.orders set carrier_id = '${assigned.user.id}', carrier_vehicle_id = '${assigned.vehicleId}', status = 'assigned', assigned_at = now() where id = '${portersId}';`);
  });

  const rows = async (c: TestUser | typeof anon, table: string, orderId: string) => {
    const client = "client" in c ? c.client : c;
    const { data, error } = await client.from(table).select("order_id").eq("order_id", orderId);
    if (error) return -1;
    return (data ?? []).length;
  };

  it("order_porter_jobs: own customer, assigned carrier, admin", async () => {
    expect(await rows(customer, "order_porter_jobs", portersId)).toBe(1);
    expect(await rows(assigned.user, "order_porter_jobs", portersId)).toBe(1);
    expect(await rows(admin, "order_porter_jobs", portersId)).toBe(1);
    expect(await rows(otherCustomer, "order_porter_jobs", portersId)).toBe(0);
    expect(await rows(otherCarrier.user, "order_porter_jobs", portersId)).toBe(0);
    expect(await rows(anon, "order_porter_jobs", portersId)).toBeLessThanOrEqual(0);
  });

  it("order_porter_carrier_terms: assigned carrier and admin, never the customer", async () => {
    expect(await rows(customer, "order_porter_carrier_terms", portersId)).toBe(0);
    expect(await rows(assigned.user, "order_porter_carrier_terms", portersId)).toBe(1);
    expect(await rows(admin, "order_porter_carrier_terms", portersId)).toBe(1);
    expect(await rows(otherCarrier.user, "order_porter_carrier_terms", portersId)).toBe(0);
    expect(await rows(anon, "order_porter_carrier_terms", portersId)).toBeLessThanOrEqual(0);
  });

  it("warehouse_bookings: own customer and admin, never carriers", async () => {
    expect(await rows(customer, "warehouse_bookings", storageId)).toBe(1);
    expect(await rows(admin, "warehouse_bookings", storageId)).toBe(1);
    expect(await rows(otherCustomer, "warehouse_bookings", storageId)).toBe(0);
    expect(await rows(assigned.user, "warehouse_bookings", storageId)).toBe(0);
    expect(await rows(anon, "warehouse_bookings", storageId)).toBeLessThanOrEqual(0);
    // even a carrier on a transport order of the same customer sees no bookings at all
    expect((await check(assigned.user.client.from("warehouse_bookings").select("id"))).length).toBe(0);
  });

  it("warehouse_box_capacity: admin only (read and write)", async () => {
    expect((await check(admin.client.from("warehouse_box_capacity").select("box_code").eq("warehouse_id", warehouseId))).length).toBe(1);
    for (const c of [customer, assigned.user]) {
      expect((await check(c.client.from("warehouse_box_capacity").select("box_code"))).length).toBe(0);
      const { data } = await c.client.from("warehouse_box_capacity").update({ quantity: 99 }).eq("warehouse_id", warehouseId).select();
      expect(data ?? []).toEqual([]);
      expect((await c.client.from("warehouse_box_capacity").insert({ warehouse_id: warehouseId, box_code: "m", quantity: 5 })).error).not.toBeNull();
    }
    expect((await anon.from("warehouse_box_capacity").select("box_code")).data ?? []).toEqual([]);
    expect((await check(service.from("warehouse_box_capacity").select("quantity").eq("warehouse_id", warehouseId).eq("box_code", "s").single())).quantity).toBe(1);
  });

  it("nobody writes the new tables directly — not even the service role (only create_service_order)", async () => {
    for (const client of [service, admin.client, customer.client]) {
      expect((await client.from("order_porter_jobs").update({ worked_minutes: 10 }).eq("order_id", portersId).select()).data ?? []).toEqual([]);
      expect((await client.from("warehouse_bookings").update({ status: "released" }).eq("order_id", storageId).select()).data ?? []).toEqual([]);
      expect((await client.from("order_porter_carrier_terms").insert({ order_id: portersId, carrier_amount_cents: 1 })).error).not.toBeNull();
    }
    expect((await check(service.from("warehouse_bookings").select("status").eq("order_id", storageId).single())).status).toBe("booked");
  });
});

describe("vehicle dispatch (transport functions) never takes porters or storage", () => {
  it("not in list_available_jobs or admin_job_candidates; accept_job and admin_assign_job refuse them", async () => {
    const porters = (await created(portersPayload({ persons: 2 }))).id;
    await pay(porters);
    const storage = (await created(storagePayload({ warehouse: await newWarehouse({ s: 1 }) }))).id;
    await pay(storage);
    const transport = await paidOrder();
    const c = await activeCarrier();

    const listed = await listedIds(c.user);
    expect(listed).toContain(transport);
    expect(listed).not.toContain(porters);
    expect(listed).not.toContain(storage);

    for (const id of [porters, storage]) {
      expect(await check(service.rpc("admin_job_candidates", { p_order_id: id, p_admin_id: admin.id }))).toEqual([]);
      expect((await accept(c.user, id, c.vehicleId)).error).not.toBeNull();
      expect((await service.rpc("admin_assign_job", { p_order_id: id, p_carrier_id: c.user.id, p_vehicle_id: c.vehicleId, p_admin_id: admin.id })).error).not.toBeNull();
      expect(await check(service.from("orders").select("status, carrier_id").eq("id", id).single())).toEqual({ status: "paid", carrier_id: null });
    }
  });

  it("a storage order can never have a carrier (CHECK holds even with triggers off)", async () => {
    const storage = (await created(storagePayload({ warehouse: await newWarehouse({ s: 1 }) }))).id;
    await pay(storage);
    const c = await activeCarrier();
    const res = localSql(`set session_replication_role = replica; update public.orders set carrier_id = '${c.user.id}', carrier_vehicle_id = '${c.vehicleId}', status = 'assigned', assigned_at = now() where id = '${storage}';`);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/23514|orders_service_fields_check/);
  });
});

describe("immutable columns and carrier fields", () => {
  it("a carrier cannot change offers_porters / porters_team_size; the server (admin) can", async () => {
    const c = await activeCarrier();
    const { error } = await c.user.client.from("carriers").update({ offers_porters: true, porters_team_size: 3 }).eq("profile_id", c.user.id);
    expect(error).not.toBeNull();
    expect(await check(service.from("carriers").select("offers_porters, porters_team_size").eq("profile_id", c.user.id).single())).toEqual({ offers_porters: false, porters_team_size: null });
    // team size and flag go together; the team is 2–4
    expect((await service.from("carriers").update({ offers_porters: true }).eq("profile_id", c.user.id)).error).not.toBeNull();
    expect((await service.from("carriers").update({ offers_porters: true, porters_team_size: 5 }).eq("profile_id", c.user.id)).error).not.toBeNull();
    await run(service.from("carriers").update({ offers_porters: true, porters_team_size: 3 }).eq("profile_id", c.user.id));
  });

  it("service_type and parent_order_id cannot change (service role included)", async () => {
    const porters = (await created(portersPayload())).id;
    const transport = await paidOrder();
    expect((await service.from("orders").update({ service_type: "storage" }).eq("id", porters)).error).not.toBeNull();
    expect((await service.from("orders").update({ service_type: "porters" }).eq("id", transport)).error).not.toBeNull();
    expect((await service.from("orders").update({ parent_order_id: transport }).eq("id", porters)).error).not.toBeNull();
    expect(await check(service.from("orders").select("service_type, parent_order_id").eq("id", porters).single())).toEqual({ service_type: "porters", parent_order_id: null });
  });

  it("a transport order still needs a vehicle type and both contacts", async () => {
    const transport = await paidOrder();
    const res = localSql(`set session_replication_role = replica; update public.orders set vehicle_type_id = null where id = '${transport}';`);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/orders_service_fields_check/);
  });
});

describe("customer e-mail for Deposito (step 6b): real order shape", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example"));
  afterEach(() => vi.unstubAllEnvs());

  it("order_paid: unit and period, no route and no pickup", async () => {
    const { sendOrderPaidEmail } = await import("@/lib/payments/server");
    const storage = (await created(storagePayload({ warehouse: await newWarehouse({ s: 1 }), start: romeDate(2), end: romeDate(31) }))).id;
    await pay(storage);
    await sendOrderPaidEmail(service, storage);
    const [m] = await check(service.from("email_outbox").select("text_body").eq("template_code", "order_paid").eq("order_id", storage));
    expect(m.text_body).toContain("Deposito: Box S");
    expect(m.text_body).toMatch(/Periodo: dal \d{2}\/\d{2}\/\d{4} al \d{2}\/\d{2}\/\d{4}/);
    expect(m.text_body).not.toContain("Percorso");
    expect(m.text_body).not.toContain("Ritiro");
  });
});
