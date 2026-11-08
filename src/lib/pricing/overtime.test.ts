import { describe, expect, it } from "vitest";
import { porterOvertimeCost, type PorterOvertimeInput } from "./overtime";

// D68, D69: worked minutes = loading + unloading (no driving). Bilocale terms: 2 persons, 3 h included,
// 35 € per person per started hour, 15 min grace, carrier 80 %.
const terms: PorterOvertimeInput["terms"] = {
  persons: 2,
  includedHours: 3,
  overtimeRatePerPersonCents: 3500,
  overtimeGraceMinutes: 15,
  carrierShare: { kind: "percent", percentBp: 8000 },
};

function cost(workedMinutes: number, patch: Partial<PorterOvertimeInput["terms"]> = {}) {
  const r = porterOvertimeCost({ workedMinutes, terms: { ...terms, ...patch }, vatRateBp: 2200 });
  if (!r.ok) throw new Error(r.message);
  return r;
}

describe("porterOvertimeCost (D68)", () => {
  it("shorter work than included → nothing, no refund", () => {
    expect(cost(150)).toMatchObject({ overtimeHours: 0, netCents: 0, vatCents: 0, grossCents: 0, carrierAmountCents: 0 });
    expect(cost(0).netCents).toBe(0);
  });

  it("exactly the included time → nothing", () => {
    expect(cost(180).overtimeHours).toBe(0);
  });

  it("grace boundary: 3 h + 15 min → 0; 3 h + 16 min → 1 started hour", () => {
    expect(cost(195).overtimeHours).toBe(0);
    expect(cost(196)).toMatchObject({ overtimeHours: 1, personHours: 2, netCents: 7000, vatCents: 1540, grossCents: 8540, carrierAmountCents: 5600 });
  });

  it("once over the grace, hours count from the included time: 4 h = 1 h, 4 h 01 = 2 h", () => {
    expect(cost(240).overtimeHours).toBe(1);
    expect(cost(241)).toMatchObject({ overtimeHours: 2, personHours: 4, netCents: 14_000, carrierAmountCents: 11_200 });
  });

  it("grace 0 → 1 minute over is 1 hour", () => {
    expect(cost(180, { overtimeGraceMinutes: 0 }).overtimeHours).toBe(0);
    expect(cost(181, { overtimeGraceMinutes: 0 }).overtimeHours).toBe(1);
  });

  it("grace longer than an hour: 3 h + 75 min → 0; 3 h + 76 min → 2 h", () => {
    expect(cost(255, { overtimeGraceMinutes: 75 }).overtimeHours).toBe(0);
    expect(cost(256, { overtimeGraceMinutes: 75 }).overtimeHours).toBe(2);
  });

  it("VAT and carrier share round half up", () => {
    // 1 person × 1 h × 0,05 € = 5 cents → VAT 22 % = 1,1 → 1; carrier 50 % = 2,5 → 3
    const r = cost(196, { persons: 1, overtimeRatePerPersonCents: 5, carrierShare: { kind: "percent", percentBp: 5000 } });
    expect(r).toMatchObject({ netCents: 5, vatCents: 1, grossCents: 6, carrierAmountCents: 3 });
  });

  it("fixed carrier share → same proportion as the package (9000 / 18000 = 50 %)", () => {
    expect(cost(196, { carrierShare: { kind: "ratio", carrierCents: 9000, netCents: 18_000 } }).carrierAmountCents).toBe(3500);
  });

  it("carrier share disabled → carrier gets nothing; overtime disabled → nothing to pay", () => {
    expect(cost(300, { carrierShare: null })).toMatchObject({ netCents: 14_000, carrierAmountCents: 0 });
    expect(cost(300, { overtimeRatePerPersonCents: null })).toMatchObject({ overtimeHours: 0, netCents: 0 });
  });

  it("rejects invalid input", () => {
    for (const workedMinutes of [-1, 1.5, Number.NaN, 24 * 60 + 1]) {
      expect(porterOvertimeCost({ workedMinutes, terms, vatRateBp: 2200 }).ok).toBe(false);
    }
    expect(porterOvertimeCost({ workedMinutes: 200, terms: { ...terms, persons: 0 }, vatRateBp: 2200 }).ok).toBe(false);
    expect(porterOvertimeCost({ workedMinutes: 200, terms: { ...terms, overtimeGraceMinutes: -5 }, vatRateBp: 2200 }).ok).toBe(false);
  });
});
