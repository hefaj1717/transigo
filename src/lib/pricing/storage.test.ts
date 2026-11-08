import { describe, expect, it } from "vitest";
import { storageCost, type StorageCostInput } from "./storage";

const base: StorageCostInput = {
  days: 10,
  pallets: 10,
  billingUnit: "pallet_day",
  shortTermMaxDays: 30,
  rates: { transshipmentFlatCents: 2500, shortTermUnitCents: 300, longTermUnitCents: 200 },
};

const total = (input: Partial<StorageCostInput>) => {
  const r = storageCost({ ...base, ...input });
  if (!r.ok) throw new Error(r.message);
  return r.totalCents;
};

describe("storageCost (D55)", () => {
  it("0 days = transshipment flat fee", () => {
    const r = storageCost({ ...base, days: 0 });
    expect(r).toMatchObject({ ok: true, storageType: "transshipment", totalCents: 2500 });
  });

  it("30 days (threshold) = short term only; 31 days adds one long-term day", () => {
    expect(total({ days: 30 })).toBe(90_000);
    expect(total({ days: 31 })).toBe(92_000);
    expect(total({ days: 31 })).toBeGreaterThan(total({ days: 30 }));
  });

  it("45 days = 30 short + 15 long (progressive)", () => {
    const r = storageCost({ ...base, days: 45 });
    expect(r.ok && r.segments.map((s) => [s.tier, s.fromDay, s.toDay, s.quantity, s.amountCents])).toEqual([
      ["short_term", 1, 30, 300, 90_000],
      ["long_term", 31, 45, 150, 30_000],
    ]);
    expect(r.ok && r.storageType).toBe("long_term");
  });

  it("cost never decreases when days are added (1 … 400 days)", () => {
    let previous = 0;
    for (let days = 1; days <= 400; days++) {
      const t = total({ days });
      expect(t).toBeGreaterThan(previous);
      previous = t;
    }
  });

  it("billing per day ignores pallets", () => {
    expect(total({ billingUnit: "day", pallets: undefined, days: 40, rates: { ...base.rates, shortTermUnitCents: 800, longTermUnitCents: 500 } })).toBe(29_000);
  });

  it("extension (Stage 7): paid 30 days + 15 more = cost(45) − cost(30)", () => {
    expect(total({ days: 15, alreadyPaidDays: 30 })).toBe(total({ days: 45 }) - total({ days: 30 }));
    expect(total({ days: 10, alreadyPaidDays: 25 })).toBe(total({ days: 35 }) - total({ days: 25 }));
    const r = storageCost({ ...base, days: 10, alreadyPaidDays: 25 });
    expect(r.ok && r.segments.map((s) => [s.fromDay, s.toDay])).toEqual([[26, 30], [31, 35]]);
  });

  it("errors: missing pallets, disabled tier, bad input", () => {
    expect(storageCost({ ...base, pallets: undefined })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(storageCost({ ...base, days: 31, rates: { ...base.rates, longTermUnitCents: null } })).toMatchObject({ ok: false, reason: "rate_disabled" });
    expect(storageCost({ ...base, days: 0, rates: { ...base.rates, transshipmentFlatCents: null } })).toMatchObject({ ok: false, reason: "rate_disabled" });
    expect(storageCost({ ...base, days: -1 })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(storageCost({ ...base, days: 0, alreadyPaidDays: 5 })).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});
