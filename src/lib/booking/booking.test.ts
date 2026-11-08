import { describe, expect, it } from "vitest";
import { calculatePrice } from "../pricing/calculate";
import { makeConfig, V } from "../pricing/__fixtures__/config";
import type { Quote } from "../pricing/types";
import { planLegs, portersFor, priceInputFor, type Endpoint, type ResolvedLeg, type WarehousePoint } from "./build";
import { bookingErrorMessage, bookingErrorStep, type BookingError } from "./messages";
import { buildOrderPayload } from "./order-payload";
import { headlineCents, toPublicQuote } from "./public-quote";
import { EMPTY_WIZARD_STATE, parseStoredState, priceRelevantKey, wizardStateSchema, type WizardState } from "./state";
import { daysBetween, isIsoDate, windowRange } from "./windows";

const A: Endpoint = { address: "Via Roma 1, Milano", placeId: "place-a", lat: 45.46, lng: 9.19, city: "Milano", postalCode: "20121", province: "MI", warehouseId: null };
const B: Endpoint = { address: "Via Po 2, Torino", placeId: "place-b", lat: 45.07, lng: 7.69, city: "Torino", postalCode: "10124", province: "TO", warehouseId: null };
const W: WarehousePoint = { id: "wh-1", address: "Magazzino, Pero", placeId: null, lat: 45.5, lng: 9.08, city: "Pero", postalCode: "20016", province: "MI" };
const NOW = new Date("2026-11-09T08:00:00Z");

const state = (patch: Partial<WizardState> = {}): WizardState => ({
  ...EMPTY_WIZARD_STATE,
  pickup: { placeId: "place-aaaaaaaaaa", label: "Via Roma 1, Milano", floor: 3, hasElevator: false },
  delivery: { placeId: "place-bbbbbbbbbb", label: "Via Po 2, Torino", floor: 1, hasElevator: false },
  pickupDate: "2026-11-11",
  pickupWindow: "10-12",
  goods: { description: "Divano", itemsCount: 1, weightKg: 80, dimensionsNote: "" },
  vehicleTypeId: "00000000-0000-4000-8000-000000000001",
  ...patch,
});

const route = (legs: ReturnType<typeof planLegs>, distances: number[]): ResolvedLeg[] => {
  if (!legs.ok) throw new Error(legs.error);
  return legs.legs.map((l, i) => ({ ...l, distanceM: distances[i], durationS: 3600 }));
};

function quoteFor(s: WizardState, distances: number[], warehouse: WarehousePoint | null = null) {
  const plan = planLegs(s, A, B, warehouse);
  if (!plan.ok) throw new Error(plan.error);
  const legs = route(plan, distances);
  const result = calculatePrice(
    priceInputFor({ state: s, legs, storageDays: plan.storageDays, storageBillingUnit: "pallet_day", vehicleTypeId: V.vanMedium, customerType: "private", now: NOW }),
    makeConfig(),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return { plan, legs, quote: result.quote };
}

describe("time windows (D73)", () => {
  it("2-hour windows in Rome time, DST-aware", () => {
    expect(windowRange("2026-11-11", "10-12")).toEqual({ start: new Date("2026-11-11T09:00:00Z"), end: new Date("2026-11-11T11:00:00Z") }); // CET
    expect(windowRange("2026-07-01", "08-10")?.start).toEqual(new Date("2026-07-01T06:00:00Z")); // CEST
    expect(windowRange("2026-02-30", "08-10")).toBeNull();
  });

  it("calendar days between dates", () => {
    expect(daysBetween("2026-11-11", "2026-11-11")).toBe(0);
    expect(daysBetween("2026-11-11", "2026-12-26")).toBe(45);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2); // across the DST switch
    expect(daysBetween("2026-11-11", "2026-11-10")).toBe(-1);
    expect(isIsoDate("2026-11-31")).toBe(false);
  });
});

describe("planLegs (D47, D72, D73)", () => {
  it("without storage: one leg A→B with the customer's floors", () => {
    const plan = planLegs(state(), A, B, null);
    expect(plan).toMatchObject({ ok: true, storageDays: null });
    if (!plan.ok) return;
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0]).toMatchObject({ pickup: A, delivery: B, pickupFloor: 3, deliveryFloor: 1, windowStart: new Date("2026-11-11T09:00:00Z") });
  });

  it("with storage: A→warehouse and warehouse→B; the warehouse side has no floor surcharge", () => {
    const plan = planLegs(state({ storage: { returnDate: "2026-11-16", returnWindow: "08-10", pallets: 2 } }), A, B, W);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.storageDays).toBe(5);
    expect(plan.legs.map((l) => [l.pickup.city, l.delivery.city, l.pickup.warehouseId, l.delivery.warehouseId])).toEqual([
      ["Milano", "Pero", null, "wh-1"],
      ["Pero", "Torino", "wh-1", null],
    ]);
    expect(plan.legs[0]).toMatchObject({ deliveryFloor: 0, deliveryHasElevator: true, pickupFloor: 3 });
    expect(plan.legs[1]).toMatchObject({ pickupFloor: 0, pickupHasElevator: true, deliveryFloor: 1, pickupDate: "2026-11-16" });
  });

  it("errors: incomplete, no warehouse, return before pickup, transshipment window too early", () => {
    expect(planLegs(state({ pickupWindow: null }), A, B, null)).toEqual({ ok: false, error: "incomplete" });
    expect(planLegs(state(), null, B, null)).toEqual({ ok: false, error: "incomplete" });
    const storage = (returnDate: string, returnWindow: "08-10" | "12-14") => state({ storage: { returnDate, returnWindow, pallets: 1 } });
    expect(planLegs(storage("2026-11-12", "08-10"), A, B, null)).toEqual({ ok: false, error: "storage_unavailable" });
    expect(planLegs(storage("2026-11-10", "08-10"), A, B, W)).toEqual({ ok: false, error: "return_before_pickup" });
    expect(planLegs(storage("2026-11-11", "08-10"), A, B, W)).toEqual({ ok: false, error: "return_window_too_early" });
    expect(planLegs(storage("2026-11-11", "12-14"), A, B, W)).toMatchObject({ ok: true, storageDays: 0 }); // transshipment
  });
});

describe("porters per leg in the wizard (D74)", () => {
  const porters = { portersPickup: { packageCode: "bilocale" as const }, portersDelivery: { packageCode: "parcels" as const, count: 2 } };

  it("without storage only the pickup choice counts (one leg)", () => {
    expect(portersFor(state(porters))).toEqual([{ legIndex: 0, packageCode: "bilocale" }]);
  });

  it("with storage: pickup → leg 1, delivery → leg 2, each priced on its own leg", () => {
    const s = state({ ...porters, storage: { returnDate: "2026-11-16", returnWindow: "08-10", pallets: 2 } });
    expect(portersFor(s)).toEqual([
      { legIndex: 0, packageCode: "bilocale" },
      { legIndex: 1, packageCode: "parcels", count: 2 },
    ]);
    const { quote } = quoteFor(s, [20_000, 150_000], W);
    expect(quote.lines.filter((l) => l.lineType === "porters").map((l) => l.legIndex)).toEqual([0, 1]);
    expect(quote.porters.map((p) => [p.legIndex, p.persons, p.includedHours])).toEqual([[0, 2, 3], [1, 2, 1]]);
    expect(quote.lines.filter((l) => l.lineType === "storage")).toHaveLength(1);
  });
});

describe("browser view of a quote (D29, D76)", () => {
  const { quote } = quoteFor(state({ portersPickup: { packageCode: "monolocale" }, packingItems: 3 }), [143_122]);

  it("contains no carrier amount, share or warning — anywhere", () => {
    const pub = toPublicQuote(quote);
    const json = JSON.stringify(pub);
    expect(json).not.toMatch(/carrier/i);
    expect(json).not.toMatch(/warning/i);
    expect(json).not.toMatch(/priceList/i);
    expect(pub.totalCents).toBe(quote.totalCents);
    expect(pub.lines.map((l) => l.grossCents)).toEqual(quote.lines.map((l) => l.grossCents));
  });

  it("porter terms with the overtime rate net and with VAT (D68, D3)", () => {
    expect(toPublicQuote(quote).porters).toEqual([
      { legIndex: 0, packageCode: "monolocale", persons: 2, includedHours: 2, overtimeRateNetCents: 3500, overtimeRateGrossCents: 4270, overtimeGraceMinutes: 15 },
    ]);
  });

  it("headline price: gross for private, net for business (D3)", () => {
    expect(headlineCents({ display: "gross", totalCents: 122, subtotalCents: 100 })).toBe(122);
    expect(headlineCents({ display: "net_plus_vat", totalCents: 122, subtotalCents: 100 })).toBe(100);
  });
});

describe("create_order payload (D77)", () => {
  const contacts = { pickupName: "Mario", pickupPhone: "+393331234567", deliveryName: "Lucia", deliveryPhone: "+393337654321", notes: " " };

  function payloadFor(s: WizardState, distances: number[], warehouse: WarehousePoint | null = null) {
    const { plan, legs, quote } = quoteFor(s, distances, warehouse);
    if (!plan.ok) throw new Error();
    return {
      quote,
      payload: buildOrderPayload({
        customerId: "cust-1",
        state: s,
        vehicleTypeId: V.vanMedium,
        legs,
        storageDays: plan.storageDays,
        storageBillingUnit: "pallet_day",
        quote,
        quotedAt: NOW,
        contacts,
        billingDetails: { customer_type: "private", fiscal_code: "RSSMRA80A01F205X" },
        termsVersion: "2026-11-01",
        termsAcceptedAt: NOW,
      }),
    };
  }

  const consistent = (quote: Quote, p: ReturnType<typeof payloadFor>["payload"]) => {
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
    expect(sum(p.lines.map((l) => l.net_cents))).toBe(p.charges.subtotal_cents);
    expect(sum(p.lines.map((l) => l.vat_cents))).toBe(p.charges.vat_cents);
    expect(p.charges.total_cents).toBe(p.charges.subtotal_cents + p.charges.vat_cents);
    expect(p.carrier_terms.map((t) => t.carrier_amount_cents)).toEqual(quote.carrierAmountByLegCents);
    for (const t of p.carrier_terms) expect(t.carrier_amount_cents).toBe(t.transport_carrier_cents + t.porters_carrier_cents + t.packing_carrier_cents);
  };

  it("one leg with porters and packing: amounts, porter snapshot and overtime rate", () => {
    const { quote, payload } = payloadFor(state({ portersPickup: { packageCode: "monolocale", count: 3 }, packingItems: 2 }), [143_122]);
    consistent(quote, payload);
    expect(payload.storage).toBeNull();
    expect(payload.legs[0]).toMatchObject({ porter_package_code: "monolocale", porters_count: 3, porters_included_hours: 2, porter_overtime_grace_minutes: 15, pickup_floor: 3, is_urgent: false });
    expect(payload.carrier_terms[0]).toMatchObject({ porter_share_kind: "percent", porter_share_bp: 8000 });
    expect(payload.carrier_terms[0].packing_carrier_cents).toBeGreaterThan(0);
    expect(payload.charges.porter_overtime_rate_cents).toBe(3500);
    expect(payload.customer_notes).toBeNull();
    expect(payload.packing_items_count).toBe(2);
  });

  it("storage order: two legs, warehouse ids, storage block and per-leg carrier terms", () => {
    const s = state({
      portersPickup: { packageCode: "bilocale" },
      portersDelivery: { packageCode: "parcels" },
      storage: { returnDate: "2026-12-26", returnWindow: "08-10", pallets: 3 },
    });
    const { quote, payload } = payloadFor(s, [20_000, 150_000], W);
    consistent(quote, payload);
    expect(payload.storage).toEqual({ storage_type: "long_term", storage_billing_unit: "pallet_day", storage_days: 45, storage_pallets: 3, warehouse_id: "wh-1" });
    expect(payload.legs.map((l) => [l.pickup_warehouse_id, l.delivery_warehouse_id, l.porter_package_code])).toEqual([
      [null, "wh-1", "bilocale"],
      ["wh-1", null, "parcels"],
    ]);
    expect(payload.lines.find((l) => l.line_type === "storage")?.leg_index).toBeNull();
    expect(payload.carrier_terms.every((t) => t.porter_share_kind === "percent")).toBe(true);
  });

  it("without porters: no porter columns and no overtime rate", () => {
    const { payload } = payloadFor(state(), [50_000]);
    expect(payload.legs[0]).toMatchObject({ porter_package_code: null, porters_count: 0, porters_included_hours: null, porter_overtime_grace_minutes: null });
    expect(payload.carrier_terms[0].porter_share_kind).toBeNull();
    expect(payload.charges.porter_overtime_rate_cents).toBeNull();
  });
});

describe("wizard state (D78)", () => {
  it("holds no contact or billing fields", () => {
    const keys = Object.keys(wizardStateSchema.shape);
    for (const forbidden of ["contacts", "billing", "fiscalCode", "phone", "email", "name"]) expect(keys).not.toContain(forbidden);
  });

  it("parseStoredState drops anything invalid", () => {
    expect(parseStoredState(JSON.stringify(state()))).toEqual(state());
    expect(parseStoredState("{")).toBeNull();
    expect(parseStoredState(JSON.stringify({ ...state(), version: 0 }))).toBeNull();
    expect(parseStoredState(null)).toBeNull();
  });

  it("price-relevant key ignores the display toggle and labels, not the porters or dates", () => {
    const base = priceRelevantKey(state());
    expect(priceRelevantKey(state({ customerTypeView: "business" }))).toBe(base);
    expect(priceRelevantKey(state({ pickup: { ...state().pickup!, label: "altro testo" } }))).toBe(base);
    expect(priceRelevantKey(state({ goods: { ...state().goods, description: "Tavolo" } }))).toBe(base);
    expect(priceRelevantKey(state({ portersPickup: { packageCode: "parcels" } }))).not.toBe(base);
    expect(priceRelevantKey(state({ pickupWindow: "08-10" }))).not.toBe(base);
    // porters at delivery only matter with storage
    expect(priceRelevantKey(state({ portersDelivery: { packageCode: "parcels" } }))).toBe(base);
  });
});

describe("Italian error messages", () => {
  const ctx = { maxDistanceKm: 300, minLeadHours: 3 };
  it("out of area, too long, too soon", () => {
    expect(bookingErrorMessage({ code: "pickup_province", legIndex: 0, province: "RM" }, ctx)).toBe("Al momento non serviamo questa zona: il ritiro deve essere in una provincia servita.");
    expect(bookingErrorMessage({ code: "max_distance", legIndex: 0, distanceM: 400_000, maxDistanceM: 300_000 }, ctx)).toBe("Il percorso supera la distanza massima di 300 km.");
    expect(bookingErrorMessage({ code: "too_soon", legIndex: 0 }, ctx)).toBe("Prenota almeno 3 ore prima del ritiro.");
    expect(bookingErrorStep({ code: "too_soon", legIndex: 0 })).toBe("data");
    expect(bookingErrorStep({ code: "max_distance", legIndex: 0, distanceM: 1, maxDistanceM: 1 })).toBe("percorso");
  });

  it("every error code has a message", () => {
    const all: BookingError[] = [
      { code: "vehicle_not_priced", legIndex: 0, vehicleTypeId: "x" },
      { code: "service_unavailable", service: "porters" },
      { code: "invalid_input", message: "x" },
      { code: "incomplete" },
      { code: "storage_unavailable" },
      { code: "invalid_window" },
      { code: "return_before_pickup" },
      { code: "return_window_too_early" },
      { code: "place_not_found", which: "pickup" },
      { code: "not_italy", which: "delivery" },
      { code: "route_not_found", legIndex: 0 },
      { code: "maps_unavailable" },
      { code: "pricing_unavailable" },
    ];
    for (const e of all) {
      expect(bookingErrorMessage(e, ctx).length).toBeGreaterThan(10);
      expect(bookingErrorStep(e)).toBeTruthy();
    }
  });
});
