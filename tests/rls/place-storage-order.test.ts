import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Endpoint } from "@/lib/booking/build";
import { placeStorageOrder, type PlaceStorageDeps } from "@/lib/booking/storage/place-order";
import { publicStorageQuote, quoteStorage, storedTotalCents, type StoredChainTransport, type StoredStorageInput } from "@/lib/booking/storage/server";
import { EMPTY_STORAGE_STATE, storagePriceKey, type StorageState } from "@/lib/booking/storage/state";
import { addDaysIso, romeToday, windowRange, type TimeWindow } from "@/lib/booking/windows";
import { calculatePrice } from "@/lib/pricing/calculate";
import { loadPricingConfig } from "@/lib/pricing/load";
import { calculateStoragePrice } from "@/lib/pricing/storage-service";
import type { PricingConfig } from "@/lib/pricing/types";
import { createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";

// Saving a Deposito order and its chain (placeStorageOrder — the core of the Deposito Server Action, step 7c) against
// the local database: the engine's lines pass create_service_order's checks, the chain transports get the transport
// snapshot (warehouse leg, carrier terms only for the carrier), quotes follow D76 (owner, expiry, key, total) and
// capacity D156. Quotes with transports are stored like quoteStorage does, with a fixed place instead of Google;
// quoteStorage itself runs for a business without transports (no Google call). LOCAL database only (D64).

const AREA = "FI";
const NOW = new Date();
const PLACE: Endpoint = { address: "Via de' Tornabuoni 1, 50123 Firenze FI", placeId: "place-storage-fi", lat: 43.771, lng: 11.251, city: "Firenze", postalCode: "50123", province: AREA, warehouseId: null };
const PLACE_CHOICE = { placeId: "place-storage-firenze", label: "Via de' Tornabuoni 1, Firenze", floor: 2, hasElevator: false };

let admin: TestUser;
let customer: TestUser;
let business: TestUser;
let otherCustomer: TestUser;
let draft: PricingConfig; // clone of the active list: boxes S/M/L
let warehouse: Endpoint & { id: string };
let requoteCalls = 0;

const run = async (p: PromiseLike<{ error: unknown }>) => {
  const { error } = await p;
  if (error) throw error;
};

/** A weekday at least `minDays` from today (Rome): no weekend surcharge on the transports. */
function weekday(minDays: number): string {
  let d = addDaysIso(romeToday(NOW), minDays);
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addDaysIso(d, 1);
  return d;
}

const state = (patch: Partial<StorageState> = {}): StorageState => {
  const start = weekday(10);
  return {
    ...EMPTY_STORAGE_STATE,
    boxCode: "m",
    startDate: start,
    endDate: weekday(45),
    goods: { ...EMPTY_STORAGE_STATE.goods, description: "Mobili del soggiorno", weightKg: 200 },
    ...patch,
  };
};

const chainState = (patch: Partial<StorageState> = {}) =>
  state({
    intake: "transigo",
    outbound: "transigo",
    intakeTransport: { place: PLACE_CHOICE, window: "10-12", porters: { packageCode: "parcels" } },
    outboundTransport: { place: PLACE_CHOICE, window: "14-16", porters: null },
    ...patch,
  });

/** Stores a quote for `owner` exactly like quoteStorage does (engine + resolved places), without Google. */
async function storeQuote(owner: TestUser | null, s: StorageState, validUntil: Date, customerType: "private" | "business" = "private") {
  const days = (Date.parse(`${s.endDate}T00:00:00Z`) - Date.parse(`${s.startDate}T00:00:00Z`)) / 86_400_000 + 1;
  const unit = customerType === "private" ? { unit: "box" as const, boxCode: s.boxCode! } : { unit: "pallet" as const, pallets: s.pallets! };
  const storage = calculateStoragePrice({ customerType, days, ...unit }, draft);
  if (!storage.ok) throw new Error(JSON.stringify(storage.error));
  const vehicleTypeId = draft.vehicleRates[1]?.vehicleTypeId ?? draft.vehicleRates[0].vehicleTypeId;
  const transport = (role: "intake" | "outbound"): StoredChainTransport => {
    const t = role === "intake" ? s.intakeTransport : s.outboundTransport;
    const date = role === "intake" ? s.startDate! : s.endDate!;
    const range = windowRange(date, t.window as TimeWindow)!;
    const wh: Endpoint = { ...warehouse, warehouseId: warehouse.id };
    const [from, to] = role === "intake" ? [{ e: PLACE, floor: t.place!.floor, lift: t.place!.hasElevator }, { e: wh, floor: 0, lift: true }] : [{ e: wh, floor: 0, lift: true }, { e: PLACE, floor: t.place!.floor, lift: t.place!.hasElevator }];
    const r = calculatePrice({
      customerType, now: NOW,
      legs: [{ distanceM: 9_000, vehicleTypeId, pickupAt: range.start, pickupProvince: from.e.province!, pickupFloor: from.floor, pickupHasElevator: from.lift, deliveryFloor: to.floor, deliveryHasElevator: to.lift }],
      porters: t.porters ? [{ legIndex: 0, ...t.porters }] : undefined,
    }, draft);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { id: _id, ...noId } = from.e as Endpoint & { id?: string };
    const { id: _id2, ...noId2 } = to.e as Endpoint & { id?: string };
    return {
      vehicleTypeId, vehicleName: "Furgone",
      leg: {
        pickup: noId, delivery: noId2, pickupDate: date, windowStart: range.start.toISOString(), windowEnd: range.end.toISOString(),
        pickupFloor: from.floor, pickupHasElevator: from.lift, deliveryFloor: to.floor, deliveryHasElevator: to.lift, distanceM: 9_000, durationS: 1_200,
      },
      quote: r.quote,
    };
  };
  const input: StoredStorageInput = {
    kind: "storage", key: storagePriceKey(s, customerType), ownerId: owner?.id ?? null, state: s, warehouseId: warehouse.id, days,
    storage: storage.quote,
    transports: { ...(s.intake === "transigo" ? { intake: transport("intake") } : {}), ...(s.outbound === "transigo" ? { outbound: transport("outbound") } : {}) },
    now: NOW.toISOString(),
  };
  const { data, error } = await service
    .from("quotes")
    .insert({ price_list_id: storage.quote.priceListId, customer_type: customerType, input, quote: storage.quote, created_at: new Date(validUntil.getTime() - 30 * 60_000).toISOString(), valid_until: validUntil.toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  return { quoteId: data.id as string, input, total: storedTotalCents(input) };
}

const deps = (now = NOW): PlaceStorageDeps => ({
  db: service,
  now,
  requote: async (_db, s, type, _now, ownerId) => {
    requoteCalls++;
    const owner = [customer, business, otherCustomer].find((u) => u.id === ownerId) ?? null;
    const q = await storeQuote(owner, s, new Date(NOW.getTime() + 30 * 60_000), type);
    const validUntil = new Date(NOW.getTime() + 30 * 60_000);
    return {
      outcome: { ok: true, quoteId: q.quoteId, validUntil: validUntil.toISOString(), quote: publicStorageQuote(q.input) },
      server: { quoteId: q.quoteId, validUntil, input: q.input },
    };
  },
});

const PRIVATE_BILLING = { fiscalCode: "RSSMRA80A01F205X", street: "Via Roma 1", city: "Firenze", postalCode: "50123", province: AREA };
const BUSINESS_BILLING = { companyName: "Delta Srl", vatNumber: "00743110157", sdiCode: "M5UXCR1", street: "Via Roma 2", city: "Firenze", postalCode: "50123", province: AREA };

const request = (s: StorageState, quoteId: string | null, shownTotalCents: number, patch: Record<string, unknown> = {}) => ({
  state: s,
  quoteId,
  shownTotalCents,
  contacts: { siteName: "Mario Rossi", sitePhone: "333 123 4567", notes: "Citofono Rossi" },
  billing: PRIVATE_BILLING,
  acceptTerms: true,
  ...patch,
});

const me = () => ({ userId: customer.id, customerType: "private" as const });
const biz = () => ({ userId: business.id, customerType: "business" as const });

async function ordersOf(user: TestUser) {
  const { count, error } = await service.from("orders").select("id", { count: "exact", head: true }).eq("customer_id", user.id);
  if (error) throw error;
  return count ?? 0;
}

const created = (r: Awaited<ReturnType<typeof placeStorageOrder>>) => {
  if (r.status !== "created") throw new Error(JSON.stringify(r));
  return r;
};

beforeAll(async () => {
  [admin, customer, business, otherCustomer] = await Promise.all([
    createUser({}),
    createUser({ first_name: "Sara", last_name: "Prova" }),
    createUser({ first_name: "Bruno", last_name: "Delta" }),
    createUser({ first_name: "Altro", last_name: "Cliente" }),
  ]);
  await run(service.from("profiles").update({ role: "admin" }).eq("id", admin.id));
  await run(service.from("customers").insert([
    { profile_id: customer.id, customer_type: "private" },
    { profile_id: otherCustomer.id, customer_type: "private" },
    { profile_id: business.id, customer_type: "business", company_name: "Delta Srl", vat_number: "00743110157", sdi_code: "M5UXCR1" },
  ]));
  const activeId = (await service.from("price_lists").select("id").eq("status", "active").single()).data!.id as string;
  const { data: draftId, error } = await admin.client.rpc("clone_price_list", { p_source_id: activeId });
  if (error) throw error;
  draft = { ...(await loadPricingConfig(service, draftId as string)), serviceAreaProvinces: [AREA] };
  if (!draft.storageBoxes.some((b) => b.code === "m")) throw new Error("the draft price list has no box M");
  await run(service.from("service_area_provinces").update({ is_active: true }).eq("province_code", AREA));

  await run(service.from("warehouses").update({ is_active: false }).eq("is_active", true));
  const w = (await service.from("warehouses").insert({
    name: "Magazzino Firenze", address: "Via del Magazzino 5, 50127 Firenze FI", city: "Firenze", postal_code: "50127", province: AREA, lat: 43.8, lng: 11.2, is_active: true, pallet_capacity: 20,
  }).select("id, address, place_id, lat, lng, city, postal_code, province").single()).data!;
  warehouse = { id: w.id, address: w.address, placeId: w.place_id, lat: w.lat, lng: w.lng, city: w.city, postalCode: w.postal_code, province: w.province, warehouseId: null };
  await run(admin.client.from("warehouse_box_capacity").insert([
    { warehouse_id: w.id, box_code: "m", quantity: 50 },
    { warehouse_id: w.id, box_code: "l", quantity: 1 },
  ]));
});

beforeEach(() => {
  requoteCalls = 0;
});

afterAll(async () => {
  await service.from("service_area_provinces").update({ is_active: false }).eq("province_code", AREA);
  await service.from("warehouses").update({ is_active: false }).neq("name", "");
  await deleteCreatedUsers().catch(() => undefined);
});

describe("placeStorageOrder: created orders", () => {
  it("box, porto io + ritiro io: one storage order with the engine's lines; no contact needed", async () => {
    const s = state();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    const r = created(await placeStorageOrder(deps(), me(), request(s, q.quoteId, q.total, { contacts: { notes: "" } })));
    expect(requoteCalls).toBe(0);
    const order = (await service.from("orders").select("service_type, status, parent_order_id, goods_description").eq("id", r.orderId).single()).data;
    expect(order).toEqual({ service_type: "storage", status: "pending_payment", parent_order_id: null, goods_description: "Mobili del soggiorno" });
    const booking = (await service.from("warehouse_bookings").select("warehouse_id, unit, box_code, pallets, start_date, end_date, intake, outbound, payment_plan").eq("order_id", r.orderId).single()).data;
    expect(booking).toEqual({ warehouse_id: warehouse.id, unit: "box", box_code: "m", pallets: null, start_date: s.startDate, end_date: s.endDate, intake: "self", outbound: "self", payment_plan: "upfront" });
    const lines = (await service.from("order_lines").select("line_type, net_cents, carrier_share_group").eq("order_id", r.orderId).order("sort_order")).data!;
    expect(lines).toEqual(q.input.storage.lines.map((l) => ({ line_type: "storage", net_cents: l.netCents, carrier_share_group: "none" })));
    expect((await service.from("quotes").select("id").eq("id", q.quoteId)).data).toEqual([]);
  });

  it("ritiro + deposito + consegna: the chain with transport snapshots, contacts and carrier terms", async () => {
    const s = chainState();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    const r = created(await placeStorageOrder(deps(), me(), request(s, q.quoteId, q.total)));
    const rows = (await service.from("orders").select("id, service_type, parent_order_id, pickup_contact_name, pickup_contact_phone, delivery_contact_name, vehicle_type_id")
      .or(`id.eq.${r.orderId},parent_order_id.eq.${r.orderId}`)).data!;
    expect(rows.length).toBe(3);
    const intake = rows.find((o) => o.id === r.orderId)!;
    const storageOrder = rows.find((o) => o.service_type === "storage")!;
    const outbound = rows.find((o) => o.service_type === "transport" && o.id !== r.orderId)!;
    expect(intake).toMatchObject({ service_type: "transport", parent_order_id: null, pickup_contact_name: "Mario Rossi", pickup_contact_phone: "+393331234567", delivery_contact_name: "Magazzino Firenze" });
    expect(storageOrder.parent_order_id).toBe(r.orderId);
    expect(outbound).toMatchObject({ parent_order_id: r.orderId, pickup_contact_name: "Magazzino Firenze", delivery_contact_name: "Mario Rossi" });

    const legs = (await service.from("order_legs").select("order_id, pickup_city, pickup_warehouse_id, delivery_warehouse_id, pickup_date, pickup_floor, delivery_floor, porter_package_code")
      .in("order_id", [intake.id, outbound.id])).data!;
    expect(legs.find((l) => l.order_id === intake.id)).toMatchObject({ pickup_warehouse_id: null, delivery_warehouse_id: warehouse.id, pickup_date: s.startDate, pickup_floor: 2, delivery_floor: 0, porter_package_code: "parcels" });
    expect(legs.find((l) => l.order_id === outbound.id)).toMatchObject({ pickup_warehouse_id: warehouse.id, delivery_warehouse_id: null, pickup_date: s.endDate, porter_package_code: null });

    const terms = (await service.from("order_leg_carrier_terms").select("order_id, carrier_amount_cents").in("order_id", [intake.id, outbound.id])).data!;
    expect(terms.find((t) => t.order_id === intake.id)!.carrier_amount_cents).toBe(q.input.transports.intake!.quote.carrierAmountCents);
    expect(terms.find((t) => t.order_id === outbound.id)!.carrier_amount_cents).toBe(q.input.transports.outbound!.quote.carrierAmountCents);
    // the customer never reads carrier amounts (D29)
    expect((await customer.client.from("order_leg_carrier_terms").select("order_id").in("order_id", [intake.id, outbound.id])).data ?? []).toEqual([]);

    const totals = (await service.from("order_charges").select("total_cents").in("order_id", rows.map((o) => o.id))).data!;
    expect(totals.reduce((a, c) => a + c.total_cents, 0)).toBe(q.total);
  });

  it("business, pallets, consegna later (D153 'Lo deciderò più avanti')", async () => {
    const s = state({ customerTypeView: "business", boxCode: null, pallets: 4, outbound: "later" });
    const q = await storeQuote(business, s, new Date(NOW.getTime() + 30 * 60_000), "business");
    const r = created(await placeStorageOrder(deps(), biz(), request(s, q.quoteId, q.total, { billing: BUSINESS_BILLING, contacts: {} })));
    const booking = (await service.from("warehouse_bookings").select("unit, pallets, box_code, outbound").eq("order_id", r.orderId).single()).data;
    expect(booking).toEqual({ unit: "pallet", pallets: 4, box_code: null, outbound: "later" });
    const charges = (await service.from("order_charges").select("customer_type, billing_details").eq("order_id", r.orderId).single()).data!;
    expect(charges.customer_type).toBe("business");
    expect((charges.billing_details as Record<string, unknown>).company_name).toBe("Delta Srl");
  });
});

describe("placeStorageOrder: checks — no order, Italian message", () => {
  it("expired quote → re-quote; then confirm again", async () => {
    const s = state();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() - 60_000));
    const before = await ordersOf(customer);
    const r = await placeStorageOrder(deps(), me(), request(s, q.quoteId, q.total, { contacts: {} }));
    expect(r).toMatchObject({ status: "price_changed", message: expect.stringMatching(/scaduto/) });
    if (r.status !== "price_changed") throw new Error("unreachable");
    expect(requoteCalls).toBe(1);
    expect(await ordersOf(customer)).toBe(before);
    expect(JSON.stringify(r)).not.toMatch(/carrier/i);
    created(await placeStorageOrder(deps(), me(), request(s, r.quoteId, r.quote.totalCents, { contacts: {} })));
  });

  it("quote of another customer: refused, no re-quote", async () => {
    const s = state();
    const q = await storeQuote(otherCustomer, s, new Date(NOW.getTime() + 30 * 60_000));
    const r = await placeStorageOrder(deps(), me(), request(s, q.quoteId, q.total, { contacts: {} }));
    expect(r).toMatchObject({ status: "error", step: "preventivo" });
    expect(requoteCalls).toBe(0);
  });

  it("the state changed after the quote (other end date) or another total shown → price_changed", async () => {
    const s = state();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    const moved = { ...s, endDate: addDaysIso(s.endDate!, 3) };
    expect((await placeStorageOrder(deps(), me(), request(moved, q.quoteId, q.total, { contacts: {} }))).status).toBe("price_changed");
    expect(requoteCalls).toBe(1);
    const q2 = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    expect((await placeStorageOrder(deps(), me(), request(s, q2.quoteId, q2.total - 1, { contacts: {} }))).status).toBe("price_changed");
  });

  it("with a transport the on-site contact is required; terms; description", async () => {
    const s = chainState();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    const r = await placeStorageOrder(deps(), me(), request(s, q.quoteId, q.total, { contacts: { notes: "" }, acceptTerms: false }));
    expect(r).toMatchObject({ status: "invalid", fieldErrors: { "contacts.siteName": expect.any(String), "contacts.sitePhone": expect.any(String), acceptTerms: expect.any(String) } });
    const empty = { ...s, goods: { ...s.goods, description: "  " } };
    expect(await placeStorageOrder(deps(), me(), request(empty, q.quoteId, q.total))).toMatchObject({ status: "error", step: "merce" });
  });

  it("the pickup too soon at confirmation time (D50) → back to 'arrivo'", async () => {
    const s = chainState();
    const pickupAt = windowRange(s.startDate!, "10-12")!.start;
    const late = new Date(pickupAt.getTime() - 60 * 60_000); // the quote is still valid then; the lead time is not
    const q = await storeQuote(customer, s, new Date(late.getTime() + 30 * 60_000));
    const r = await placeStorageOrder({ ...deps(late), now: late }, me(), request(s, q.quoteId, q.total));
    expect(r).toMatchObject({ status: "error", step: "arrivo" });
  });

  it("the last box went meanwhile (D156) → no_space, back to 'periodo'", async () => {
    const s = state({ boxCode: "l", startDate: weekday(60), endDate: weekday(70) });
    const a = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    const b = await storeQuote(otherCustomer, s, new Date(NOW.getTime() + 30 * 60_000));
    created(await placeStorageOrder(deps(), me(), request(s, a.quoteId, a.total, { contacts: {} })));
    const r = await placeStorageOrder(deps(), { userId: otherCustomer.id, customerType: "private" }, request(s, b.quoteId, b.total, { contacts: {} }));
    expect(r).toMatchObject({ status: "error", step: "periodo", message: expect.stringMatching(/posti liberi/) });
  });
});

describe("quoteStorage on the active price list (no transport: no Google call)", () => {
  it("business pallets: quote stored for the owner; the browser view has no carrier data; it orders", async () => {
    const s = state({ customerTypeView: "business", boxCode: null, pallets: 3 });
    const { outcome, server } = await quoteStorage(service, s, "business", NOW, business.id);
    if (!outcome.ok || !server) throw new Error(JSON.stringify(outcome));
    expect(outcome.quote.parts.map((p) => p.role)).toEqual(["storage"]);
    expect(outcome.quote.totalCents).toBe(server.input.storage.totalCents);
    expect(JSON.stringify(outcome)).not.toMatch(/carrier/i);
    created(await placeStorageOrder(deps(), biz(), request(s, outcome.quoteId, outcome.quote.totalCents, { billing: BUSINESS_BILLING, contacts: {} })));
  });

  it("errors: missing unit, start in the past, end before start, more pallets than free places", async () => {
    const fail = async (s: StorageState) => {
      const { outcome } = await quoteStorage(service, s, "business", NOW, business.id);
      return outcome.ok ? null : outcome.error.code;
    };
    expect(await fail(state({ boxCode: "m", pallets: null }))).toBe("incomplete"); // a business books pallets (D154)
    expect(await fail(state({ boxCode: null, pallets: 2, startDate: addDaysIso(romeToday(NOW), -1) }))).toBe("invalid_period");
    expect(await fail(state({ boxCode: null, pallets: 2, startDate: weekday(20), endDate: weekday(10) }))).toBe("invalid_period");
    expect(await fail(state({ boxCode: null, pallets: 21 }))).toBe("no_space");
  });

  it("a transport with an unknown place → its own error, before any price", async () => {
    // place IDs are resolved by Google: without a real one the wizard gets a place / maps error for that transport
    const { outcome } = await quoteStorage(service, state({ customerTypeView: "business", boxCode: null, pallets: 2, intake: "transigo", intakeTransport: { place: null, window: "10-12", porters: null } }), "business", NOW, null);
    expect(outcome).toEqual({ ok: false, error: { code: "transport_incomplete", role: "intake" } });
  });
});
