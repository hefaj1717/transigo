import { describe, expect, it } from "vitest";
import { makeConfig, withRule } from "./__fixtures__/config";
import { calculateStoragePrice, storageBoxCost, type StoragePriceInput } from "./storage-service";

const M = { dayCents: 500, monthCents: 10_000 }; // Box M in the fixture

function ok(input: StoragePriceInput, config = makeConfig()) {
  const r = calculateStoragePrice(input, config);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const q = r.quote;
  expect(q.lines.reduce((s, l) => s + l.netCents, 0)).toBe(q.subtotalCents);
  expect(q.lines.reduce((s, l) => s + l.vatCents, 0)).toBe(q.vatCents);
  for (const l of q.lines) {
    expect(l.quantity * (l.unitAmountCents ?? 0)).toBe(l.netCents);
    expect(l.carrierAmountCents).toBe(0); // storage is 100 % Transigo
  }
  expect(q.carrierAmountCents).toBe(0);
  return q;
}

describe("storageBoxCost (D154)", () => {
  it.each([
    [1, 500],
    [2, 1000],
    [19, 9500],
    [20, 10_000], // day rate equals the month: not capped
    [21, 10_000], // capped at one month
    [30, 10_000],
    [31, 10_500],
    [45, 17_500], // 1 month + 15 days × 5 €
    [60, 20_000],
    [90, 30_000],
  ])("%i days", (days, expected) => {
    expect(storageBoxCost(M, days).totalCents).toBe(expected);
  });

  it("never decreases when a day is added", () => {
    let prev = 0;
    for (let d = 1; d <= 400; d++) {
      const t = storageBoxCost(M, d).totalCents;
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it("0 days is not a box storage", () => {
    expect(() => storageBoxCost(M, 0)).toThrow(RangeError);
  });
});

describe("calculateStoragePrice — private, box", () => {
  it("2 days of a box M = 10,00 € net + 2,20 € VAT", () => {
    const q = ok({ customerType: "private", unit: "box", boxCode: "M", days: 2 });
    expect(q.lines.map((l) => [l.labelIt, l.quantity, l.unitAmountCents])).toEqual([["Box M (6 m³): 2 giorni", 2, 500]]);
    expect(q).toMatchObject({ subtotalCents: 1000, vatCents: 220, totalCents: 1220, storageType: "short_term", display: "gross" });
  });

  it("2 months and 25 days: months line + remaining days billed as one month", () => {
    const q = ok({ customerType: "private", unit: "box", boxCode: "M", days: 85 });
    expect(q.lines.map((l) => [l.labelIt, l.quantity, l.unitAmountCents, l.netCents])).toEqual([
      ["Box M (6 m³): 2 mesi", 2, 10_000, 20_000],
      ["Box M (6 m³): 25 giorni (tariffa di 1 mese)", 1, 10_000, 10_000],
    ]);
    expect(q.storageType).toBe("long_term");
  });

  it("unknown or disabled box → service_unavailable; 0 days → invalid", () => {
    const disabled = makeConfig({ storageBoxes: makeConfig().storageBoxes.map((b) => ({ ...b, isEnabled: b.code !== "L" })) });
    expect(calculateStoragePrice({ customerType: "private", unit: "box", boxCode: "XL", days: 5 }, makeConfig())).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
    expect(calculateStoragePrice({ customerType: "private", unit: "box", boxCode: "L", days: 5 }, disabled)).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
    expect(calculateStoragePrice({ customerType: "private", unit: "box", boxCode: "M", days: 0 }, makeConfig())).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("calculateStoragePrice — business, pallets (D55)", () => {
  it("5 pallets, 20 days = 300,00 € net + 66,00 € VAT", () => {
    const q = ok({ customerType: "business", unit: "pallet", pallets: 5, days: 20 });
    expect(q.lines.map((l) => [l.labelIt, l.quantity, l.unitAmountCents])).toEqual([["Deposito breve periodo, giorni 1–20, 5 pallet", 100, 300]]);
    expect(q).toMatchObject({ subtotalCents: 30_000, vatCents: 6600, totalCents: 36_600, display: "net_plus_vat", storageType: "short_term" });
  });

  it("billed per pallet-day even when the price list's transport option is per day", () => {
    const q = ok({ customerType: "business", unit: "pallet", pallets: 5, days: 20 }, makeConfig({ storageBillingUnit: "day" }));
    expect(q.subtotalCents).toBe(30_000);
  });

  it("45 days = 30 short + 15 long; 0 days = transshipment", () => {
    expect(ok({ customerType: "business", unit: "pallet", pallets: 2, days: 45 }).subtotalCents).toBe(2 * (30 * 300 + 15 * 200));
    expect(ok({ customerType: "business", unit: "pallet", pallets: 2, days: 0 })).toMatchObject({ subtotalCents: 2500, storageType: "transshipment" });
  });

  it("disabled long-term rate → service_unavailable", () => {
    const config = withRule(makeConfig(), "storage_pallet_day_long", { isEnabled: false });
    expect(calculateStoragePrice({ customerType: "business", unit: "pallet", pallets: 1, days: 31 }, config)).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
  });
});
