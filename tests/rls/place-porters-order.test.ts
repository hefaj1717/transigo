import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Endpoint } from "@/lib/booking/build";
import { placePortersOrder, type PlacePortersDeps } from "@/lib/booking/porters/place-order";
import type { StoredPortersInput } from "@/lib/booking/porters/server";
import { EMPTY_PORTERS_STATE, portersPriceKey, type PortersState } from "@/lib/booking/porters/state";
import { addDaysIso, romeToday, windowRange, type TimeWindow } from "@/lib/booking/windows";
import { loadPricingConfig } from "@/lib/pricing/load";
import { calculatePortersPrice } from "@/lib/pricing/porters-service";
import type { PricingConfig, Quote } from "@/lib/pricing/types";
import { createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";

// Saving a Facchinaggio order (placePortersOrder — the core of the porters Server Action, step 6c) against the
// local database: the engine's lines pass create_service_order's checks (D157 minimum, D159 surcharges, floors),
// the carrier amount lands only in order_porter_carrier_terms, and quotes follow D76 (owner, expiry, key, total).
// Google is replaced by a stub (the place is fixed). LOCAL database only (D64).

const AREA = "BO";
const PLACE: Endpoint = { address: "Via dell'Indipendenza 10, 40121 Bologna BO", placeId: "place-porters-bo", lat: 44.499, lng: 11.343, city: "Bologna", postalCode: "40121", province: AREA, warehouseId: null };
const NOW = new Date();

let admin: TestUser;
let customer: TestUser;
let otherCustomer: TestUser;
let config: PricingConfig; // draft clone of the active list: porters service with minimum 2 h / 2 persons, floor rate
let requoteCalls = 0;

const run = async (p: PromiseLike<{ error: unknown }>) => {
  const { error } = await p;
  if (error) throw error;
};

/** First day of the given weekday (0 = Sunday … 6 = Saturday) at least `minDays` from today (Rome). */
function nextWeekday(weekday: number, minDays = 10): string {
  let d = addDaysIso(romeToday(NOW), minDays);
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== weekday) d = addDaysIso(d, 1);
  return d;
}

const state = (patch: Partial<PortersState> = {}): PortersState => ({
  ...EMPTY_PORTERS_STATE,
  place: { placeId: "place-porters-bologna", label: "Via dell'Indipendenza 10, Bologna", floor: 3, hasElevator: false },
  date: nextWeekday(3), // a Wednesday: no weekend surcharge
  window: "10-12",
  persons: 2,
  hours: 3,
  description: "Armadio e 10 scatoloni",
  ...patch,
});

/** Stores a quote for `owner` exactly like quotePorters does (engine + resolved place), without Google. */
async function storeQuote(owner: TestUser | null, s: PortersState, validUntil: Date, customerType: "private" | "business" = "private") {
  const range = windowRange(s.date!, s.window as TimeWindow)!;
  const r = calculatePortersPrice(
    { customerType, now: NOW, startAt: range.start, province: AREA, persons: s.persons, hours: s.hours, floor: s.place!.floor, hasElevator: s.place!.hasElevator },
    config,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const input: StoredPortersInput = {
    kind: "porters", key: portersPriceKey(s), ownerId: owner?.id ?? null, state: s, place: PLACE,
    window: { date: s.date!, start: range.start.toISOString(), end: range.end.toISOString() }, job: r.job, now: NOW.toISOString(),
  };
  const { data, error } = await service
    .from("quotes")
    .insert({ price_list_id: r.quote.priceListId, customer_type: customerType, input, quote: r.quote, created_at: new Date(validUntil.getTime() - 30 * 60_000).toISOString(), valid_until: validUntil.toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  return { quoteId: data.id as string, quote: r.quote, input };
}

const deps = (): PlacePortersDeps => ({
  db: service,
  now: NOW,
  requote: async (_db, s, type, _now, ownerId) => {
    requoteCalls++;
    const owner = ownerId === customer.id ? customer : ownerId === otherCustomer.id ? otherCustomer : null;
    const q = await storeQuote(owner, s, new Date(NOW.getTime() + 30 * 60_000), type);
    return {
      outcome: { ok: true, quoteId: q.quoteId, validUntil: "", quote: q.quote as never, job: q.input.job as never, city: PLACE.city },
      server: { quoteId: q.quoteId, validUntil: new Date(NOW.getTime() + 30 * 60_000), quote: q.quote, input: q.input },
    };
  },
});

const request = (s: PortersState, quoteId: string | null, shownTotalCents: number, patch: Record<string, unknown> = {}) => ({
  state: s,
  quoteId,
  shownTotalCents,
  contacts: { siteName: "Mario Rossi", sitePhone: "333 123 4567", notes: "Citofono Rossi" },
  billing: { fiscalCode: "RSSMRA80A01F205X", street: "Via Roma 1", city: "Bologna", postalCode: "40121", province: AREA },
  acceptTerms: true,
  ...patch,
});

const me = () => ({ userId: customer.id, customerType: "private" as const });

async function ordersOf(user: TestUser) {
  const { count, error } = await service.from("orders").select("id", { count: "exact", head: true }).eq("customer_id", user.id);
  if (error) throw error;
  return count ?? 0;
}

beforeAll(async () => {
  [admin, customer, otherCustomer] = await Promise.all([
    createUser({}),
    createUser({ first_name: "Sara", last_name: "Prova" }),
    createUser({ first_name: "Altro", last_name: "Cliente" }),
  ]);
  await run(service.from("profiles").update({ role: "admin" }).eq("id", admin.id));
  await run(service.from("customers").insert([customer, otherCustomer].map((u) => ({ profile_id: u.id, customer_type: "private" }))));
  const activeId = (await service.from("price_lists").select("id").eq("status", "active").single()).data!.id as string;
  const { data: draftId, error } = await admin.client.rpc("clone_price_list", { p_source_id: activeId });
  if (error) throw error;
  const loaded = await loadPricingConfig(service, draftId as string);
  if (!loaded.portersService) throw new Error("the draft price list has no porters service");
  config = { ...loaded, serviceAreaProvinces: [AREA] };
  await run(service.from("service_area_provinces").update({ is_active: true }).eq("province_code", AREA));
});

beforeEach(() => {
  requoteCalls = 0;
});

afterAll(async () => {
  await service.from("service_area_provinces").update({ is_active: false }).eq("province_code", AREA);
  await deleteCreatedUsers().catch(() => undefined);
});

describe("placePortersOrder: control case", () => {
  it("a valid quote of the customer creates the order; lines and amounts are the engine's", async () => {
    const s = state();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    const result = await placePortersOrder(deps(), me(), request(s, q.quoteId, q.quote.totalCents));
    expect(result).toMatchObject({ status: "created", orderNumber: expect.stringMatching(/^TG-\d{4}-\d{6}$/) });
    if (result.status !== "created") throw new Error("unreachable");
    expect(requoteCalls).toBe(0);

    const order = (await service.from("orders").select("service_type, status, vehicle_type_id, pickup_contact_name, pickup_contact_phone, goods_description, customer_notes").eq("id", result.orderId).single()).data;
    expect(order).toEqual({ service_type: "porters", status: "pending_payment", vehicle_type_id: null, pickup_contact_name: "Mario Rossi", pickup_contact_phone: "+393331234567", goods_description: "Armadio e 10 scatoloni", customer_notes: "Citofono Rossi" });
    const job = (await service.from("order_porter_jobs").select("address, city, province, floor, has_elevator, persons, requested_hours, billed_hours, is_urgent").eq("order_id", result.orderId).single()).data;
    expect(job).toEqual({ address: PLACE.address, city: "Bologna", province: AREA, floor: 3, has_elevator: false, persons: 2, requested_hours: 3, billed_hours: 3, is_urgent: false });
    const lines = (await service.from("order_lines").select("line_type, net_cents, vat_cents, carrier_share_group").eq("order_id", result.orderId).order("sort_order")).data!;
    expect(lines).toEqual(q.quote.lines.map((l) => ({ line_type: l.lineType, net_cents: l.netCents, vat_cents: l.vatCents, carrier_share_group: "porters" })));
    expect(lines.map((l) => l.line_type)).toEqual(["porters", "porters_floors"]);
    const charges = (await service.from("order_charges").select("total_cents, porter_overtime_rate_cents").eq("order_id", result.orderId).single()).data!;
    expect(charges.total_cents).toBe(q.quote.totalCents);
    expect(charges.porter_overtime_rate_cents).toBe(q.input.job.overtimeRatePerPersonCents);
    const terms = (await service.from("order_porter_carrier_terms").select("carrier_amount_cents").eq("order_id", result.orderId).single()).data!;
    expect(terms.carrier_amount_cents).toBe(q.quote.carrierAmountCents);
    // the customer never reads the carrier amount (D29); the quote row is gone
    expect((await customer.client.from("order_porter_carrier_terms").select("order_id").eq("order_id", result.orderId)).data ?? []).toEqual([]);
    expect((await service.from("quotes").select("id").eq("id", q.quoteId)).data).toEqual([]);
  });

  it("hours below the minimum: billed at the minimum (D157), requested hours kept", async () => {
    const s = state({ hours: 1, place: { placeId: "place-porters-bologna", label: "x", floor: 0, hasElevator: true } });
    const q = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    const result = await placePortersOrder(deps(), me(), request(s, q.quoteId, q.quote.totalCents));
    if (result.status !== "created") throw new Error(JSON.stringify(result));
    const job = (await service.from("order_porter_jobs").select("requested_hours, billed_hours").eq("order_id", result.orderId).single()).data;
    expect(job).toEqual({ requested_hours: 1, billed_hours: config.portersService!.minHours });
  });

  it("Saturday: the weekend surcharge (D159) passes the database checks", async () => {
    const s = state({ date: nextWeekday(6) });
    const q = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    expect(q.quote.lines.map((l) => l.lineType)).toContain("surcharge_weekend_holiday"); // enabled in the seeded price list
    const result = await placePortersOrder(deps(), me(), request(s, q.quoteId, q.quote.totalCents));
    if (result.status !== "created") throw new Error(JSON.stringify(result));
    const types = (await service.from("order_lines").select("line_type").eq("order_id", result.orderId)).data!.map((l) => l.line_type);
    expect(types).toContain("surcharge_weekend_holiday");
  });
});

describe("placePortersOrder: quote checks (D76) — no order, Italian message", () => {
  it("expired quote: re-quote and confirm again; the browser gets no carrier amounts", async () => {
    const s = state();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() - 60_000));
    const before = await ordersOf(customer);
    const result = await placePortersOrder(deps(), me(), request(s, q.quoteId, q.quote.totalCents));
    expect(result).toMatchObject({ status: "price_changed", message: expect.stringMatching(/scaduto/) });
    if (result.status !== "price_changed") throw new Error("unreachable");
    expect(requoteCalls).toBe(1);
    expect(await ordersOf(customer)).toBe(before);
    expect(JSON.stringify(result)).not.toMatch(/carrier/i);
    expect(result.job).toMatchObject({ persons: 2, includedHours: 3 });
    const again = await placePortersOrder(deps(), me(), request(s, result.quoteId, result.quote.totalCents));
    expect(again.status).toBe("created");
  });

  it("quote of another customer: refused, no re-quote", async () => {
    const s = state();
    const foreign = await storeQuote(otherCustomer, s, new Date(NOW.getTime() + 30 * 60_000));
    const before = await ordersOf(customer);
    const result = await placePortersOrder(deps(), me(), request(s, foreign.quoteId, foreign.quote.totalCents));
    expect(result).toMatchObject({ status: "error", step: "preventivo" });
    expect(requoteCalls).toBe(0);
    expect(await ordersOf(customer)).toBe(before);
  });

  it("changed team or hours after the quote, different shown total, a transport quote id: re-quote, no order", async () => {
    const s = state();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    const before = await ordersOf(customer);
    expect((await placePortersOrder(deps(), me(), request({ ...s, persons: 3 }, q.quoteId, q.quote.totalCents))).status).toBe("price_changed");
    expect((await placePortersOrder(deps(), me(), request(s, q.quoteId, q.quote.totalCents + 100))).status).toBe("price_changed");
    // a quote row of the transport wizard is never used here
    const { data: transportQuote } = await service.from("quotes").insert({
      price_list_id: q.quote.priceListId, customer_type: "private", input: { key: "x", ownerId: customer.id }, quote: q.quote as unknown as Quote,
      created_at: NOW.toISOString(), valid_until: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    }).select("id").single();
    expect((await placePortersOrder(deps(), me(), request(s, transportQuote!.id, q.quote.totalCents))).status).toBe("price_changed");
    expect(await ordersOf(customer)).toBe(before);
  });

  it("business account with a private quote: re-quote", async () => {
    const s = state();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    const result = await placePortersOrder(deps(), { userId: customer.id, customerType: "business" }, request(s, q.quoteId, q.quote.totalCents, {
      billing: { companyName: "Delta Srl", vatNumber: "01234567897", sdiCode: "M5UXCR1", street: "Via Roma 1", city: "Bologna", postalCode: "40121", province: AREA },
    }));
    expect(result.status).toBe("price_changed");
  });
});

describe("placePortersOrder: form checks", () => {
  it("missing contact, bad phone, terms not accepted → field errors; empty description → step cosa", async () => {
    const s = state();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    const before = await ordersOf(customer);
    const invalid = await placePortersOrder(deps(), me(), request(s, q.quoteId, q.quote.totalCents, { contacts: { siteName: "", sitePhone: "12", notes: "" }, acceptTerms: false }));
    expect(invalid).toMatchObject({ status: "invalid", fieldErrors: { "contacts.siteName": expect.any(String), "contacts.sitePhone": expect.any(String), acceptTerms: expect.any(String) } });
    const noGoods = await placePortersOrder(deps(), me(), request({ ...s, description: "   " }, q.quoteId, q.quote.totalCents));
    expect(noGoods).toEqual({ status: "error", message: "Descrivi cosa c'è da spostare.", step: "cosa" });
    expect(await ordersOf(customer)).toBe(before);
  });

  it("start closer than the minimum lead time at confirmation → step data, no order (D50)", async () => {
    const s = state();
    const range = windowRange(s.date!, "10-12")!;
    const q = await storeQuote(customer, s, range.start); // still valid at confirmation
    const late: PlacePortersDeps = { ...deps(), now: new Date(range.start.getTime() - 3_600_000) };
    const before = await ordersOf(customer);
    const result = await placePortersOrder(late, me(), request(s, q.quoteId, q.quote.totalCents));
    expect(result).toEqual({ status: "error", message: `Prenota almeno ${config.minBookingLeadHours} ore prima dell'inizio del lavoro.`, step: "data" });
    expect(requoteCalls).toBe(0);
    expect(await ordersOf(customer)).toBe(before);
  });
});
