import { describe, expect, it } from "vitest";
import { isStorageOutOfArea, storageErrorMessage, storageErrorStep, toPublicStorageQuote } from "./messages";
import { buildStorageOrderPayload } from "./payload";
import type { StoredStorageInput } from "./server";
import {
  EMPTY_STORAGE_STATE,
  endDateFor,
  parseStoragePrefill,
  parseStoredStorageState,
  storagePeriodDays,
  storagePriceKey,
  type StorageState,
} from "./state";
import type { PublicQuote } from "../public-quote";
import type { Quote } from "../../pricing/types";

const base: StorageState = { ...EMPTY_STORAGE_STATE, boxCode: "m", startDate: "2026-12-01", endDate: "2026-12-31" };

describe("state", () => {
  it("period: inclusive days; reversed or missing → null; end date for a number of days", () => {
    expect(storagePeriodDays(base)).toBe(31);
    expect(storagePeriodDays({ startDate: "2026-12-01", endDate: "2026-12-01" })).toBe(1);
    expect(storagePeriodDays({ startDate: "2026-12-02", endDate: "2026-12-01" })).toBeNull();
    expect(storagePeriodDays({ startDate: null, endDate: "2026-12-01" })).toBeNull();
    expect(endDateFor("2026-12-01", 30)).toBe("2026-12-30");
    expect(endDateFor("2026-12-01", 1)).toBe("2026-12-01");
  });

  it("price key: ignores what does not change the price, changes with what does", () => {
    const k = storagePriceKey(base, "private");
    expect(storagePriceKey({ ...base, pallets: 7, customerTypeView: "business", goods: { ...base.goods, description: "x" } }, "private")).toBe(k);
    expect(storagePriceKey({ ...base, endDate: "2027-01-01" }, "private")).not.toBe(k);
    expect(storagePriceKey({ ...base, boxCode: "l" }, "private")).not.toBe(k);
    expect(storagePriceKey(base, "business")).not.toBe(k);
    // a transport's address and window count only when Transigo does it
    const place = { placeId: "place-abcdefghij", label: "x", floor: 0, hasElevator: false };
    expect(storagePriceKey({ ...base, intakeTransport: { place, window: "10-12", porters: null } }, "private")).toBe(k);
    const withIntake = { ...base, intake: "transigo" as const, intakeTransport: { place, window: "10-12" as const, porters: null } };
    expect(storagePriceKey(withIntake, "private")).not.toBe(storagePriceKey({ ...withIntake, intakeTransport: { ...withIntake.intakeTransport, window: "12-14" } }, "private"));
    expect(storagePriceKey(withIntake, "private")).not.toBe(storagePriceKey({ ...withIntake, goods: { ...withIntake.goods, weightKg: 900 } }, "private"));
  });

  it("stored state: invalid or older shapes are dropped", () => {
    expect(parseStoredStorageState(JSON.stringify(base))).toEqual(base);
    expect(parseStoredStorageState(JSON.stringify({ ...base, intake: "drone" }))).toBeNull();
    expect(parseStoredStorageState("{")).toBeNull();
    expect(parseStoredStorageState(null)).toBeNull();
  });

  it("calculator prefill (D162): only a known box and integers in range", () => {
    expect(parseStoragePrefill({ servizio: "deposito", box: "m", giorni: "45" }, ["s", "m"])).toEqual({ boxCode: "m", pallets: undefined, days: 45 });
    expect(parseStoragePrefill({ pallet: "4", giorni: "20" }, ["s"])).toEqual({ boxCode: undefined, pallets: 4, days: 20 });
    expect(parseStoragePrefill({ box: "xl", pallet: "0", giorni: "99999" }, ["s"])).toEqual({ boxCode: undefined, pallets: undefined, days: undefined });
    expect(parseStoragePrefill({ box: ["m"], giorni: "1e3", pallet: "-1" }, ["m"])).toEqual({ boxCode: undefined, pallets: undefined, days: undefined });
  });
});

describe("messages", () => {
  const ctx = { minLeadHours: 24 };
  it("each error has an Italian message and the step that fixes it", () => {
    expect(storageErrorStep({ code: "no_space" })).toBe("periodo");
    expect(storageErrorStep({ code: "place_not_found", role: "outbound" })).toBe("uscita");
    expect(storageErrorStep({ code: "transport_pricing", role: "intake", error: { code: "too_soon", legIndex: 0 } })).toBe("arrivo");
    expect(storageErrorStep({ code: "transport_pricing", role: "intake", error: { code: "service_unavailable", service: "porters" } })).toBe("facchini");
    expect(storageErrorStep({ code: "no_vehicle_fits", role: "intake" })).toBe("merce");
    expect(storageErrorMessage({ code: "transport_pricing", role: "intake", error: { code: "too_soon", legIndex: 0 } }, ctx)).toBe("Per il ritiro prenota almeno 24 ore prima della fascia oraria.");
    expect(storageErrorMessage({ code: "transport_pricing", role: "outbound", error: { code: "pickup_province", legIndex: 0, province: "PA" } }, ctx)).toMatch(/consegne/);
    expect(isStorageOutOfArea({ code: "transport_pricing", role: "intake", error: { code: "max_distance", legIndex: 0, distanceM: 1, maxDistanceM: 0 } })).toBe(true);
    expect(isStorageOutOfArea({ code: "no_space" })).toBe(false);
  });

  it("public quote: totals are the exact sums of the parts; headline gross for private, net for business", () => {
    const q = (net: number, vat: number, type: "private" | "business" = "private"): PublicQuote => ({
      customerType: type, display: type === "private" ? "gross" : "net_plus_vat", vatRateBp: 2200, lines: [], subtotalCents: net, vatCents: vat, totalCents: net + vat, storageType: null, porters: [], isUrgentByLeg: [],
    });
    const p = toPublicStorageQuote([{ role: "intake", quote: q(10_000, 2_200), distanceKm: 9, vehicleName: "Furgone" }, { role: "storage", quote: q(6_000, 1_320), distanceKm: null, vehicleName: null }], 31);
    expect(p).toMatchObject({ subtotalCents: 16_000, vatCents: 3_520, totalCents: 19_520, headlineCents: 19_520, days: 31 });
    expect(toPublicStorageQuote([{ role: "storage", quote: q(6_000, 1_320, "business"), distanceKm: null, vehicleName: null }], 1).headlineCents).toBe(6_000);
  });
});

describe("buildStorageOrderPayload", () => {
  const quote = (lines: Quote["lines"], carrier = 0): Quote => ({
    priceListId: "pl", priceListVersion: 9, customerType: "private", display: "gross", vatRateBp: 2200, lines,
    subtotalCents: lines.reduce((s, l) => s + l.netCents, 0), vatCents: lines.reduce((s, l) => s + l.vatCents, 0),
    totalCents: lines.reduce((s, l) => s + l.grossCents, 0), carrierAmountCents: carrier, carrierAmountByLegCents: [carrier], storageType: "long_term", porters: [], isUrgentByLeg: [false], warnings: [],
  });
  const storageLine = { lineType: "storage", labelIt: "Box M: 1 mese", legIndex: null, quantity: 1, unitAmountCents: 10_000, netCents: 10_000, vatCents: 2_200, grossCents: 12_200, carrierShareGroup: "none", carrierAmountCents: 0 } as Quote["lines"][number];
  const transportLine = { lineType: "transport", labelIt: "Trasporto", legIndex: 0, quantity: 1, unitAmountCents: 8_000, netCents: 8_000, vatCents: 1_760, grossCents: 9_760, carrierShareGroup: "transport", carrierAmountCents: 6_000 } as Quote["lines"][number];
  const wh = { address: "Magazzino", placeId: null, lat: 43.8, lng: 11.2, city: "Firenze", postalCode: "50127", province: "FI", warehouseId: "wh-1" };
  const home = { address: "Via Roma 1", placeId: "p1", lat: 43.7, lng: 11.2, city: "Firenze", postalCode: "50123", province: "FI", warehouseId: null };
  const input = (s: StorageState, intake = false): StoredStorageInput => ({
    kind: "storage", key: "k", ownerId: "u", state: s, warehouseId: "wh-1", days: 31, storage: quote([storageLine]), now: "2026-11-12T10:00:00.000Z",
    transports: intake ? { intake: { vehicleTypeId: "vt", vehicleName: "Furgone", quote: quote([transportLine], 6_000), leg: {
      pickup: home, delivery: wh, pickupDate: "2026-12-01", windowStart: "2026-12-01T09:00:00.000Z", windowEnd: "2026-12-01T11:00:00.000Z",
      pickupFloor: 2, pickupHasElevator: false, deliveryFloor: 0, deliveryHasElevator: true, distanceM: 9_000, durationS: 1_200 } } } : {},
  });
  const args = (i: StoredStorageInput) => ({
    customerId: "c", customerType: "private" as const, input: i, siteContact: { name: "Mario", phone: "+39333" }, warehouseContact: { name: "Magazzino Firenze", phone: "+39055" },
    notes: " Citofono ", description: "Mobili", billingDetails: { first_name: "Mario" }, termsVersion: "t", termsAcceptedAt: new Date("2026-11-12T10:05:00Z"),
  });

  it("storage only: booking, storage lines, no transports, upfront", () => {
    const p = buildStorageOrderPayload(args(input(base)));
    expect(p.booking).toEqual({ warehouse_id: "wh-1", unit: "box", box_code: "m", pallets: null, start_date: "2026-12-01", end_date: "2026-12-31", payment_plan: "upfront", intake: "self", outbound: "self" });
    expect(p.lines.map((l) => [l.line_type, l.carrier_share_group])).toEqual([["storage", "none"]]);
    expect(p.charges.total_cents).toBe(12_200);
    expect(p.customer_notes).toBe("Citofono");
    expect("intake_transport" in p).toBe(false);
  });

  it("intake by Transigo: the create_order shape on the warehouse leg; carrier amount only in carrier_terms", () => {
    const s = { ...base, intake: "transigo" as const };
    const p = buildStorageOrderPayload(args(input(s, true)));
    const t = p.intake_transport!;
    expect(t.legs).toHaveLength(1);
    expect(t.legs[0]).toMatchObject({ pickup_warehouse_id: null, delivery_warehouse_id: "wh-1", pickup_date: "2026-12-01", pickup_floor: 2 });
    expect(t).toMatchObject({ pickup_contact_name: "Mario", delivery_contact_name: "Magazzino Firenze", vehicle_type_id: "vt", storage: null, packing_items_count: 0 });
    expect(t.carrier_terms).toEqual([expect.objectContaining({ carrier_amount_cents: 6_000, transport_carrier_cents: 6_000 })]);
    expect(JSON.stringify(t.lines)).not.toMatch(/carrier_amount/);
    expect(t.charges.billing_details).toEqual(p.charges.billing_details); // one invoice for the chain (D153)
  });

  it("refuses a state that does not match the stored transports", () => {
    expect(() => buildStorageOrderPayload(args(input({ ...base, intake: "transigo" })))).toThrow(/transports/);
    expect(() => buildStorageOrderPayload(args(input({ ...base, boxCode: null })))).toThrow(/unit/);
  });
});
