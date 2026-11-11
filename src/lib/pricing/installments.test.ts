import { describe, expect, it } from "vitest";
import { applyBp } from "./money";
import { installmentPlan, MONTHLY_PLAN_MIN_DAYS } from "./installments";

describe("installmentPlan (D155)", () => {
  it("only above 2 months (61 days)", () => {
    expect(MONTHLY_PLAN_MIN_DAYS).toBe(61);
    expect(installmentPlan({ netCents: 30_000, vatRateBp: 2200, days: 60, startDate: "2026-12-01" })).toEqual({ ok: false, reason: "too_short" });
    expect(installmentPlan({ netCents: 30_000, vatRateBp: 2200, days: 61, startDate: "2026-12-01" })).toMatchObject({ ok: true });
  });

  it("one installment per started 30-day month; first at booking, next every 30 days from the start", () => {
    const plan = installmentPlan({ netCents: 30_000, vatRateBp: 2200, days: 85, startDate: "2026-12-15" });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.installments.map((i) => [i.index, i.dueDate, i.netCents, i.vatCents, i.grossCents])).toEqual([
      [0, null, 10_000, 2200, 12_200],
      [1, "2027-01-14", 10_000, 2200, 12_200],
      [2, "2027-02-13", 10_000, 2200, 12_200],
    ]);
    expect(plan.totalCents).toBe(36_600);
  });

  it("net remainder goes to the first installment; VAT per installment", () => {
    const plan = installmentPlan({ netCents: 10_001, vatRateBp: 2200, days: 90, startDate: "2026-12-01" });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.installments.map((i) => i.netCents)).toEqual([3335, 3333, 3333]);
    expect(plan.installments.reduce((s, i) => s + i.netCents, 0)).toBe(10_001);
    for (const i of plan.installments) expect(i.vatCents).toBe(applyBp(i.netCents, 2200));
    // Plan total differs from the one-off total by at most 1 cent per installment.
    const oneOff = 10_001 + applyBp(10_001, 2200);
    expect(Math.abs(plan.totalCents - oneOff)).toBeLessThanOrEqual(plan.installments.length);
  });

  it("rejects bad input", () => {
    expect(installmentPlan({ netCents: 0, vatRateBp: 2200, days: 90, startDate: "2026-12-01" })).toEqual({ ok: false, reason: "invalid_input" });
    expect(installmentPlan({ netCents: 100, vatRateBp: 2200, days: 90, startDate: "2026-02-30" })).toEqual({ ok: false, reason: "invalid_input" });
  });
});
