import { describe, expect, it } from "vitest";
import { calculatePrice } from "./calculate";
import { leg, makeConfig, NOW, V, WEEKDAY, withRule } from "./__fixtures__/config";
import type { PriceInput, PriceResult, PricingConfig, Quote } from "./types";

const HOUR = 3_600_000;
const at = (iso: string) => new Date(iso);

function quote(input: Partial<PriceInput>, config: PricingConfig = makeConfig()): Quote {
  const result = calculatePrice({ customerType: "private", now: NOW, legs: [leg()], ...input }, config);
  if (!result.ok) throw new Error(`expected a quote, got ${JSON.stringify(result.error)}`);
  expectConsistent(result.quote);
  return result.quote;
}

function error(input: Partial<PriceInput>, config: PricingConfig = makeConfig()) {
  const result: PriceResult = calculatePrice({ customerType: "private", now: NOW, legs: [leg()], ...input }, config);
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

/** Invariants that must hold for every quote (D56, D57). */
function expectConsistent(q: Quote) {
  const sum = (f: (l: Quote["lines"][number]) => number) => q.lines.reduce((s, l) => s + f(l), 0);
  expect(sum((l) => l.netCents)).toBe(q.subtotalCents);
  expect(sum((l) => l.vatCents)).toBe(q.vatCents);
  expect(q.totalCents).toBe(q.subtotalCents + q.vatCents);
  expect(sum((l) => l.carrierAmountCents)).toBe(q.carrierAmountCents);
  expect(q.carrierAmountByLegCents.reduce((s, a) => s + a, 0)).toBe(q.carrierAmountCents);
  for (const l of q.lines) {
    expect(Number.isSafeInteger(l.netCents) && Number.isSafeInteger(l.vatCents) && Number.isSafeInteger(l.carrierAmountCents)).toBe(true);
    expect(l.grossCents).toBe(l.netCents + l.vatCents);
    expect(l.quantity * (l.unitAmountCents ?? 0)).toBe(l.netCents); // invoice: quantity × unit = amount
  }
}

const lineOf = (q: Quote, type: string) => q.lines.filter((l) => l.lineType === type);

describe("transport per vehicle type (D48)", () => {
  it.each([
    ["auto", V.car, 50_000, 50 * 90],
    ["furgone piccolo", V.vanSmall, 80_000, 80 * 110],
    ["furgone medio", V.vanMedium, 120_000, 120 * 140],
    ["furgone grande", V.vanLarge, 200_000, 200 * 170],
    ["camion con sponda", V.truck, 250_000, 250 * 220],
  ])("%s: km × rate", (_name, vehicleTypeId, distanceM, expected) => {
    const q = quote({ legs: [leg({ vehicleTypeId, distanceM })] });
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0]).toMatchObject({ lineType: "transport", quantity: distanceM / 1000, netCents: expected });
    expect(q.subtotalCents).toBe(expected);
  });

  it("basic quote: net, 22 % VAT, gross and 70 % carrier share", () => {
    const q = quote({});
    expect(q).toMatchObject({ subtotalCents: 4500, vatCents: 990, totalCents: 5490, carrierAmountCents: 3150, priceListId: "pl-1" });
    expect(q.lines[0].labelIt).toBe("Trasporto Auto / station wagon, 50 km");
  });

  it("minimum price applies when km × rate is lower (quantity 1 × minimum)", () => {
    const q = quote({ legs: [leg({ distanceM: 10_000 })] });
    expect(q.lines[0]).toMatchObject({ quantity: 1, unitAmountCents: 3500, netCents: 3500 });
    expect(q.lines[0].labelIt).toContain("10 km (prezzo minimo)");
  });

  it("exactly at the minimum the km price is used; one km less uses the minimum", () => {
    const config = makeConfig({ vehicleRates: [{ vehicleTypeId: V.car, nameIt: "Auto", ratePerKmCents: 100, minPriceCents: 4000 }] });
    expect(quote({ legs: [leg({ distanceM: 40_000 })] }, config).lines[0]).toMatchObject({ quantity: 40, netCents: 4000 });
    expect(quote({ legs: [leg({ distanceM: 39_000 })] }, config).lines[0]).toMatchObject({ quantity: 1, netCents: 4000 });
  });

  it("distance is rounded up to whole km: 12 001 m → 13 km, 12 000 m → 12 km", () => {
    const config = makeConfig({ vehicleRates: [{ vehicleTypeId: V.car, nameIt: "Auto", ratePerKmCents: 90, minPriceCents: 0 }] });
    expect(quote({ legs: [leg({ distanceM: 12_001 })] }, config).lines[0]).toMatchObject({ quantity: 13, netCents: 1170 });
    expect(quote({ legs: [leg({ distanceM: 12_000 })] }, config).lines[0]).toMatchObject({ quantity: 12, netCents: 1080 });
  });

  it("vehicle type without a rate in the price list → vehicle_not_priced", () => {
    expect(error({ legs: [leg({ vehicleTypeId: "unknown" })] })).toEqual({ code: "vehicle_not_priced", legIndex: 0, vehicleTypeId: "unknown" });
  });
});

describe("urgent surcharge (D49, D50)", () => {
  it("pickup in 23 h → +30 % of transport", () => {
    const q = quote({ legs: [leg({ pickupAt: new Date(NOW.getTime() + 23 * HOUR) })] });
    expect(lineOf(q, "surcharge_urgent")[0]).toMatchObject({ netCents: 1350, carrierShareGroup: "transport" });
    expect(q.isUrgentByLeg).toEqual([true]);
  });

  it("pickup in exactly 24 h is not urgent", () => {
    const q = quote({ legs: [leg({ pickupAt: new Date(NOW.getTime() + 24 * HOUR) })] });
    expect(lineOf(q, "surcharge_urgent")).toHaveLength(0);
  });

  it("percentage applies to the minimum price, not to km × rate", () => {
    const q = quote({ legs: [leg({ distanceM: 10_000, pickupAt: new Date(NOW.getTime() + 5 * HOUR) })] });
    expect(lineOf(q, "surcharge_urgent")[0].netCents).toBe(1050); // 30 % of 3500
  });

  it("pickup in less than the minimum lead time → too_soon; exactly 3 h is accepted", () => {
    expect(error({ legs: [leg({ pickupAt: new Date(NOW.getTime() + 2 * HOUR) })] })).toEqual({ code: "too_soon", legIndex: 0 });
    expect(error({ legs: [leg({ pickupAt: new Date(NOW.getTime() - HOUR) })] }).code).toBe("too_soon");
    expect(quote({ legs: [leg({ pickupAt: new Date(NOW.getTime() + 3 * HOUR) })] }).isUrgentByLeg).toEqual([true]);
  });

  it("fixed urgent surcharge", () => {
    const config = withRule(makeConfig(), "surcharge_urgent", { kind: "fixed", amountCents: 2500, percentBp: null });
    const q = quote({ legs: [leg({ pickupAt: new Date(NOW.getTime() + 10 * HOUR) })] }, config);
    expect(lineOf(q, "surcharge_urgent")[0]).toMatchObject({ quantity: 1, unitAmountCents: 2500, netCents: 2500 });
  });
});

describe("weekend / holiday surcharge (D51)", () => {
  it.each([
    ["Saturday", "2026-11-14T08:00:00Z"],
    ["Sunday", "2026-11-15T08:00:00Z"],
    ["holiday on a weekday (Tue 8 Dec)", "2026-12-08T08:00:00Z"],
  ])("%s → +20 %%", (_name, iso) => {
    const q = quote({ legs: [leg({ pickupAt: at(iso) })] });
    expect(lineOf(q, "surcharge_weekend_holiday")[0]).toMatchObject({ netCents: 900, carrierShareGroup: "transport" });
  });

  it("weekday that is not a holiday → no surcharge", () => {
    expect(lineOf(quote({}), "surcharge_weekend_holiday")).toHaveLength(0);
  });

  it("holiday on a Sunday (1 Nov 2026) is charged once", () => {
    const q = quote({ now: at("2026-10-20T08:00:00Z"), legs: [leg({ pickupAt: at("2026-11-01T08:00:00Z") })] });
    expect(lineOf(q, "surcharge_weekend_holiday")).toHaveLength(1);
  });

  it("uses the Rome calendar: Friday 23:30 UTC is already Saturday in Italy", () => {
    expect(lineOf(quote({ legs: [leg({ pickupAt: at("2026-11-13T23:30:00Z") })] }), "surcharge_weekend_holiday")).toHaveLength(1);
    expect(lineOf(quote({ legs: [leg({ pickupAt: at("2026-11-13T22:30:00Z") })] }), "surcharge_weekend_holiday")).toHaveLength(0);
  });

  it("urgent + weekend add up on the same base (30 % + 20 %, not compounded)", () => {
    const q = quote({ now: at("2026-11-13T10:00:00Z"), legs: [leg({ pickupAt: at("2026-11-14T08:00:00Z") })] });
    expect(lineOf(q, "surcharge_urgent")[0].netCents).toBe(1350);
    expect(lineOf(q, "surcharge_weekend_holiday")[0].netCents).toBe(900);
    expect(q.subtotalCents).toBe(4500 + 1350 + 900);
  });

  it("a disabled rule adds no line", () => {
    const config = withRule(makeConfig(), "surcharge_weekend_holiday", { isEnabled: false });
    expect(lineOf(quote({ legs: [leg({ pickupAt: at("2026-11-14T08:00:00Z") })] }, config), "surcharge_weekend_holiday")).toHaveLength(0);
  });
});

describe("floors without elevator (D53)", () => {
  it("3rd floor without elevator at pickup + 2nd floor with elevator at delivery → 3 × 10 €", () => {
    const q = quote({ legs: [leg({ pickupFloor: 3, pickupHasElevator: false, deliveryFloor: 2, deliveryHasElevator: true })] });
    expect(lineOf(q, "surcharge_floors")[0]).toMatchObject({ quantity: 3, unitAmountCents: 1000, netCents: 3000, carrierShareGroup: "transport" });
  });

  it("floors on both ends without elevator add up; ground floor or elevator → nothing", () => {
    const both = quote({ legs: [leg({ pickupFloor: 2, deliveryFloor: 4 })] });
    expect(lineOf(both, "surcharge_floors")[0].quantity).toBe(6);
    const none = quote({ legs: [leg({ pickupFloor: 5, pickupHasElevator: true, deliveryFloor: 0 })] });
    expect(lineOf(none, "surcharge_floors")).toHaveLength(0);
  });
});

describe("porters and packing (D54, D67)", () => {
  it("porters, bilocale package: 2 persons × 3 h included × 30 €, carrier 80 % (D67)", () => {
    const q = quote({ porters: { packageCode: "bilocale" } });
    expect(lineOf(q, "porters")[0]).toMatchObject({ quantity: 6, unitAmountCents: 3000, netCents: 18_000, carrierAmountCents: 14_400 });
    expect(lineOf(q, "porters")[0].labelIt).toBe("Facchinaggio – Bilocale: 2 persone × 3 h incluse");
  });

  it("porters: the customer adds a person, who gets the package's hours (3 × 3 h)", () => {
    const q = quote({ porters: { packageCode: "bilocale", count: 3 } });
    expect(lineOf(q, "porters")[0]).toMatchObject({ quantity: 9, netCents: 27_000, carrierAmountCents: 21_600 });
  });

  it("porters: one person, parcels → singular label", () => {
    expect(lineOf(quote({ porters: { packageCode: "parcels" } }), "porters")[0].labelIt).toBe("Facchinaggio – Pochi colli / oggetti singoli: 1 persona × 1 h incluse");
  });

  it("porters: quote carries the terms for the wizard and the order (D68)", () => {
    const q = quote({ porters: { packageCode: "trilocale_plus", count: 4 } });
    expect(q.porters).toEqual({
      packageCode: "trilocale_plus",
      persons: 4,
      includedHours: 4,
      overtimeRatePerPersonCents: 3500,
      overtimeGraceMinutes: 15,
      carrierShare: { kind: "percent", percentBp: 8000 },
    });
    expect(quote({}).porters).toBeNull();
  });

  it("porters: overtime rule disabled → no overtime rate in the terms", () => {
    const config = withRule(makeConfig(), "porter_overtime_hour", { isEnabled: false });
    expect(quote({ porters: { packageCode: "monolocale" } }, config).porters?.overtimeRatePerPersonCents).toBeNull();
  });

  it("porters: fixed carrier share → overtime keeps the package's proportion", () => {
    const config = withRule(makeConfig(), "carrier_share_porters", { kind: "fixed", amountCents: 9000, percentBp: null });
    expect(quote({ porters: { packageCode: "bilocale" } }, config).porters?.carrierShare).toEqual({ kind: "ratio", carrierCents: 9000, netCents: 18_000 });
  });

  it("packing: flat 15 € + 10 items × 5 €, carrier 60 %", () => {
    const q = quote({ packing: { itemsCount: 10 } });
    const packing = lineOf(q, "packing");
    expect(packing.map((l) => l.netCents)).toEqual([1500, 5000]);
    expect(packing.reduce((s, l) => s + l.carrierAmountCents, 0)).toBe(3900); // 60 % of 6500
  });

  it("packing with the flat fee disabled → only per item; both disabled → service_unavailable", () => {
    const perItemOnly = withRule(makeConfig(), "packing_flat", { isEnabled: false });
    expect(lineOf(quote({ packing: { itemsCount: 4 } }, perItemOnly), "packing").map((l) => l.netCents)).toEqual([2000]);
    const none = withRule(perItemOnly, "packing_per_item", { isEnabled: false });
    expect(error({ packing: { itemsCount: 4 } }, none)).toEqual({ code: "service_unavailable", service: "packing" });
  });

  it("porters: porter_hour disabled, package disabled or missing → service_unavailable", () => {
    const unavailable = { code: "service_unavailable", service: "porters" };
    expect(error({ porters: { packageCode: "parcels" } }, withRule(makeConfig(), "porter_hour", { isEnabled: false }))).toEqual(unavailable);
    const pkgOff = makeConfig();
    pkgOff.porterPackages = pkgOff.porterPackages.map((p) => (p.code === "bilocale" ? { ...p, isEnabled: false } : p));
    expect(error({ porters: { packageCode: "bilocale" } }, pkgOff)).toEqual(unavailable);
    expect(error({ porters: { packageCode: "bilocale" } }, makeConfig({ porterPackages: [] }))).toEqual(unavailable);
  });

  it("porters: fewer persons than the package, more than 4, unknown package, bad leg → invalid_input", () => {
    expect(error({ porters: { packageCode: "trilocale_plus", count: 2 } })).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/at least 3/) });
    expect(error({ porters: { packageCode: "bilocale", count: 5 } }).code).toBe("invalid_input");
    expect(error({ porters: { packageCode: "villa" as never } }).code).toBe("invalid_input");
    expect(error({ porters: { packageCode: "parcels", legIndex: 1 } }).code).toBe("invalid_input");
  });
});

describe("storage (D55)", () => {
  it("transshipment (0 days) → flat fee, 100 % Transigo", () => {
    const q = quote({ storage: { days: 0 } });
    expect(lineOf(q, "storage")[0]).toMatchObject({ labelIt: "Trasbordo in magazzino", netCents: 2500, carrierAmountCents: 0, carrierShareGroup: "none", legIndex: null });
    expect(q.storageType).toBe("transshipment");
  });

  it("short term: 10 pallets × 30 days × 3 € (threshold inclusive)", () => {
    const q = quote({ storage: { days: 30, pallets: 10 } });
    expect(lineOf(q, "storage")).toHaveLength(1);
    expect(lineOf(q, "storage")[0]).toMatchObject({ quantity: 300, unitAmountCents: 300, netCents: 90_000 });
    expect(q.storageType).toBe("short_term");
  });

  it("long term is progressive: 31 days = 30 short + 1 long, and costs more than 30 days", () => {
    const q31 = quote({ storage: { days: 31, pallets: 10 } });
    const q30 = quote({ storage: { days: 30, pallets: 10 } });
    expect(lineOf(q31, "storage").map((l) => [l.labelIt, l.netCents])).toEqual([
      ["Deposito breve periodo, giorni 1–30, 10 pallet", 90_000],
      ["Deposito lungo periodo, giorni 31–31, 10 pallet", 2000],
    ]);
    expect(q31.storageType).toBe("long_term");
    expect(q31.subtotalCents).toBeGreaterThan(q30.subtotalCents);
  });

  it("billing per day (admin setting): 40 days = 30 × 8 € + 10 × 5 €", () => {
    const q = quote({ storage: { days: 40 } }, makeConfig({ storageBillingUnit: "day" }));
    expect(lineOf(q, "storage").map((l) => l.netCents)).toEqual([24_000, 5000]);
  });

  it("pallet billing without pallets → invalid_input; disabled rate → service_unavailable", () => {
    expect(error({ storage: { days: 5 } }).code).toBe("invalid_input");
    const config = withRule(makeConfig(), "storage_pallet_day_long", { isEnabled: false });
    expect(error({ storage: { days: 31, pallets: 1 } }, config)).toEqual({ code: "service_unavailable", service: "storage" });
  });

  it("storage never adds to the carrier amount", () => {
    const withStorage = quote({ storage: { days: 10, pallets: 3 } });
    expect(withStorage.carrierAmountCents).toBe(quote({}).carrierAmountCents);
  });
});

describe("customer type (D3)", () => {
  it("private and business get identical amounts; only the display mode differs", () => {
    const input = { porters: { packageCode: "monolocale" as const }, packing: { itemsCount: 3 } };
    const p = quote({ ...input, customerType: "private" });
    const b = quote({ ...input, customerType: "business" });
    expect(p.display).toBe("gross");
    expect(b.display).toBe("net_plus_vat");
    expect({ ...p, customerType: null, display: null }).toEqual({ ...b, customerType: null, display: null });
  });
});

describe("rounding (D56)", () => {
  const oneKm = (rate: number) => makeConfig({ vehicleRates: [{ vehicleTypeId: V.car, nameIt: "Auto", ratePerKmCents: rate, minPriceCents: 0 }] });

  it("VAT half-up: 1 234 × 22 % = 271,48 → 271; 1 225 × 22 % = 269,5 → 270", () => {
    expect(quote({ legs: [leg({ distanceM: 1000 })] }, oneKm(1234))).toMatchObject({ subtotalCents: 1234, vatCents: 271, totalCents: 1505 });
    expect(quote({ legs: [leg({ distanceM: 1000 })] }, oneKm(1225))).toMatchObject({ subtotalCents: 1225, vatCents: 270, totalCents: 1495 });
  });

  it("VAT is computed on the subtotal and split so line VATs add up exactly", () => {
    // Three lines of 3 cents: per-line rounding would give 3 × 1 = 3, the subtotal 9 × 22 % = 1,98 → 2.
    const config = withRule(withRule(makeConfig({ ...oneKm(3) }), "surcharge_urgent", { kind: "fixed", amountCents: 3, percentBp: null }), "surcharge_weekend_holiday", {
      kind: "fixed",
      amountCents: 3,
      percentBp: null,
    });
    const q = quote({ now: at("2026-11-13T10:00:00Z"), legs: [leg({ distanceM: 1000, pickupAt: at("2026-11-14T08:00:00Z") })] }, config);
    expect(q.lines.map((l) => l.netCents)).toEqual([3, 3, 3]);
    expect(q.vatCents).toBe(2);
    expect(q.lines.map((l) => l.vatCents)).toEqual([1, 1, 0]);
  });

  it("carrier share percentage is rounded half-up once per group", () => {
    // 70 % of 1 235 = 864,5 → 865
    expect(quote({ legs: [leg({ distanceM: 1000 })] }, oneKm(1235)).carrierAmountCents).toBe(865);
  });
});

describe("carrier amount (D6, D14, D57)", () => {
  it("transport share includes all surcharges of the leg; porters and packing have their own rules", () => {
    const q = quote({
      now: at("2026-11-13T10:00:00Z"),
      legs: [leg({ pickupAt: at("2026-11-14T08:00:00Z"), pickupFloor: 2 })], // urgent + weekend + 2 floors
      porters: { packageCode: "parcels", count: 2 }, // 2 × 1 h
      packing: { itemsCount: 2 },
    });
    // transport group: 4500 + 1350 + 900 + 2000 = 8750 → 70 % = 6125
    // porters: 6000 → 80 % = 4800; packing: 1500 + 1000 = 2500 → 60 % = 1500
    expect(q.carrierAmountCents).toBe(6125 + 4800 + 1500);
    const transportGroup = q.lines.filter((l) => l.carrierShareGroup === "transport");
    expect(transportGroup.reduce((s, l) => s + l.carrierAmountCents, 0)).toBe(6125);
  });

  it("fixed carrier share is an amount per group", () => {
    const config = withRule(makeConfig(), "carrier_share_transport", { kind: "fixed", amountCents: 3000, percentBp: null });
    const q = quote({ legs: [leg({ pickupFloor: 1 })] }, config);
    expect(q.carrierAmountCents).toBe(3000);
    expect(q.warnings).toEqual([]);
  });

  it("carrier share above the group net amount → negative_margin warning (not capped)", () => {
    const config = withRule(makeConfig(), "carrier_share_porters", { kind: "fixed", amountCents: 10_000, percentBp: null });
    const q = quote({ porters: { packageCode: "parcels" } }, config);
    expect(lineOf(q, "porters")[0].carrierAmountCents).toBe(10_000);
    expect(q.warnings).toEqual([{ code: "negative_margin", group: "porters", legIndex: null }]);
  });
});

describe("service area (D13, D61)", () => {
  it("pickup province outside the active list → pickup_province", () => {
    expect(error({ legs: [leg({ pickupProvince: "RM" })] })).toEqual({ code: "pickup_province", legIndex: 0, province: "RM" });
    expect(error({ legs: [leg()] }, makeConfig({ serviceAreaProvinces: [] })).code).toBe("pickup_province");
  });

  it("province code is case-insensitive", () => {
    expect(quote({ legs: [leg({ pickupProvince: "mi" })] }).subtotalCents).toBe(4500);
  });

  it("max distance is inclusive: 300 000 m OK, 300 001 m → max_distance", () => {
    expect(quote({ legs: [leg({ distanceM: 300_000 })] }).lines[0].quantity).toBe(300);
    expect(error({ legs: [leg({ distanceM: 300_001 })] })).toEqual({ code: "max_distance", legIndex: 0, distanceM: 300_001, maxDistanceM: 300_000 });
  });

  it("area is checked before lead time and vehicle (out-of-area always shows the contact form)", () => {
    expect(error({ legs: [leg({ pickupProvince: "RM", vehicleTypeId: "unknown", pickupAt: NOW })] }).code).toBe("pickup_province");
  });
});

describe("legs (D47)", () => {
  it("warehouse order: A→warehouse on Monday + warehouse→B on Saturday, surcharges per leg", () => {
    const q = quote({
      now: at("2026-11-09T08:00:00Z"),
      legs: [
        leg({ vehicleTypeId: V.vanMedium, distanceM: 20_000, pickupAt: at("2026-11-09T20:00:00Z") }), // Mon, in 12 h → urgent
        leg({ vehicleTypeId: V.vanMedium, distanceM: 150_000, pickupAt: at("2026-11-14T08:00:00Z") }), // Sat
      ],
      storage: { days: 5, pallets: 5 },
    });
    expect(q.lines.map((l) => [l.lineType, l.legIndex, l.netCents])).toEqual([
      ["transport", 0, 6000], // 20 × 1,40 = 28 € < minimum 60 €
      ["surcharge_urgent", 0, 1800],
      ["transport", 1, 21_000],
      ["surcharge_weekend_holiday", 1, 4200],
      ["storage", null, 7500], // 5 pallets × 5 days × 3 €
    ]);
    expect(q.lines[0].labelIt).toBe("Tratta 1: Trasporto Furgone medio, 20 km (prezzo minimo)");
    expect(q.isUrgentByLeg).toEqual([true, false]);
    expect(q.subtotalCents).toBe(40_500);
    expect(q.vatCents).toBe(8910);
    expect(q.carrierAmountByLegCents).toEqual([5460, 17_640]); // 70 % of 7 800 and of 25 200
  });

  it("fixed transport share applies per leg (each leg can be a different carrier)", () => {
    const config = withRule(makeConfig(), "carrier_share_transport", { kind: "fixed", amountCents: 2000, percentBp: null });
    const q = quote({ legs: [leg(), leg({ pickupAt: new Date(WEEKDAY.getTime() + 24 * HOUR) })] }, config);
    expect(q.carrierAmountByLegCents).toEqual([2000, 2000]);
  });

  it("every leg must start in the service area and respect the max distance", () => {
    expect(error({ legs: [leg(), leg({ pickupProvince: "RM" })] })).toMatchObject({ code: "pickup_province", legIndex: 1 });
    expect(error({ legs: [leg(), leg({ distanceM: 400_000 })] })).toMatchObject({ code: "max_distance", legIndex: 1 });
  });

  it("invalid legs → invalid_input (none, more than 2, wrong order, negative distance)", () => {
    expect(error({ legs: [] }).code).toBe("invalid_input");
    expect(error({ legs: [leg(), leg(), leg()] }).code).toBe("invalid_input");
    expect(error({ legs: [leg({ pickupAt: at("2026-11-12T08:00:00Z") }), leg({ pickupAt: WEEKDAY })] }).code).toBe("invalid_input");
    expect(error({ legs: [leg({ distanceM: -5 })] }).code).toBe("invalid_input");
    expect(error({ legs: [leg({ distanceM: 1.5 })] }).code).toBe("invalid_input");
  });
});

describe("reference case from the project plan", () => {
  it("Milano–Torino: 143 122 m (Google Routes) → 144 km, furgone medio, porters monolocale (2 × 2 h)", () => {
    const q = quote({
      customerType: "business",
      legs: [leg({ vehicleTypeId: V.vanMedium, distanceM: 143_122, pickupProvince: "MI" })],
      porters: { packageCode: "monolocale" },
    });
    expect(q.lines.map((l) => [l.lineType, l.quantity, l.unitAmountCents, l.netCents, l.vatCents, l.grossCents, l.carrierAmountCents])).toEqual([
      ["transport", 144, 140, 20_160, 4435, 24_595, 14_112],
      ["porters", 4, 3000, 12_000, 2640, 14_640, 9600],
    ]);
    expect(q).toMatchObject({
      subtotalCents: 32_160, // 321,60 €
      vatCents: 7075, // 22 % of 321,60 = 70,752 → 70,75 €
      totalCents: 39_235, // 392,35 €
      carrierAmountCents: 23_712, // 70 % × 201,60 + 80 % × 120,00 = 237,12 €
      display: "net_plus_vat",
    });
  });
});
