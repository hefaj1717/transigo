import { describe, expect, it } from "vitest";
import { makeConfig, NOW, WEEKDAY, withRule } from "./__fixtures__/config";
import { porterOvertimeCost } from "./overtime";
import { calculatePortersPrice, type PortersPriceInput } from "./porters-service";
import type { PricingConfig } from "./types";

const input = (patch: Partial<PortersPriceInput> = {}): PortersPriceInput => ({
  customerType: "private",
  now: NOW,
  startAt: WEEKDAY,
  province: "MI",
  persons: 2,
  hours: 3,
  floor: 0,
  hasElevator: true,
  ...patch,
});

function ok(patch: Partial<PortersPriceInput> = {}, config: PricingConfig = makeConfig()) {
  const r = calculatePortersPrice(input(patch), config);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const q = r.quote;
  expect(q.lines.reduce((s, l) => s + l.netCents, 0)).toBe(q.subtotalCents);
  expect(q.lines.reduce((s, l) => s + l.vatCents, 0)).toBe(q.vatCents);
  expect(q.totalCents).toBe(q.subtotalCents + q.vatCents);
  for (const l of q.lines) expect(l.quantity * (l.unitAmountCents ?? 0)).toBe(l.netCents);
  return r;
}

describe("porters-only service (D151, D157)", () => {
  it("2 porters, 3 h, 4th floor without elevator = 220,00 € net, 48,40 € VAT, 268,40 € total", () => {
    const { quote } = ok({ floor: 4, hasElevator: false });
    expect(quote.lines.map((l) => [l.lineType, l.quantity, l.unitAmountCents, l.netCents])).toEqual([
      ["porters", 6, 3000, 18_000],
      ["porters_floors", 4, 1000, 4000],
    ]);
    expect(quote).toMatchObject({ subtotalCents: 22_000, vatCents: 4840, totalCents: 26_840, display: "gross" });
    expect(quote.lines[0].labelIt).toBe("Facchinaggio: 2 persone × 3 h");
  });

  it("carrier gets the porters share (80 %) of both lines; floors with elevator are free", () => {
    expect(ok({ floor: 4, hasElevator: false }).quote).toMatchObject({ carrierAmountCents: 17_600, carrierAmountByLegCents: [17_600] });
    expect(ok({ floor: 4, hasElevator: true }).quote.lines).toHaveLength(1);
  });

  it("hours below the minimum are billed as the minimum (label says so)", () => {
    const { quote, job } = ok({ hours: 1 });
    expect(quote.lines[0]).toMatchObject({ quantity: 4, netCents: 12_000, labelIt: "Facchinaggio: 2 persone × 2 h (minimo)" });
    expect(job.includedHours).toBe(2);
  });

  it("persons: minimum from the price list (2) up to 4", () => {
    expect(calculatePortersPrice(input({ persons: 1 }), makeConfig())).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(calculatePortersPrice(input({ persons: 5 }), makeConfig())).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(ok({ persons: 4 }).quote.subtotalCents).toBe(4 * 3 * 3000);
  });

  it("business customer: same amounts, net + VAT display", () => {
    expect(ok({ customerType: "business" }).quote).toMatchObject({ display: "net_plus_vat", subtotalCents: 18_000 });
  });

  it("weekend / holiday surcharge (D51, D159): 20 % of the porters line, not of the floors; carrier share includes it", () => {
    const saturday = new Date("2026-11-14T08:00:00Z");
    const { quote } = ok({ startAt: saturday, floor: 4, hasElevator: false });
    expect(quote.lines.map((l) => [l.lineType, l.netCents])).toEqual([
      ["porters", 18_000],
      ["surcharge_weekend_holiday", 3600],
      ["porters_floors", 4000],
    ]);
    expect(quote.carrierAmountCents).toBe(Math.round((18_000 + 3600 + 4000) * 0.8));
    expect(ok({ startAt: new Date("2026-12-08T08:00:00Z") }).quote.lines.map((l) => l.lineType)).toContain("surcharge_weekend_holiday"); // Immacolata
  });

  it("urgent surcharge (D49): start within 24 h → 30 %; urgent + weekend add up (D52)", () => {
    const in5h = new Date(NOW.getTime() + 5 * 3_600_000);
    const { quote } = ok({ startAt: in5h });
    expect(quote.lines.map((l) => [l.lineType, l.netCents])).toEqual([["porters", 18_000], ["surcharge_urgent", 5400]]);
    expect(quote.isUrgentByLeg).toEqual([true]);
    const saturdayNow = new Date("2026-11-14T06:00:00Z");
    const both = ok({ startAt: new Date("2026-11-14T12:00:00Z") }, makeConfig()).quote; // not urgent from NOW
    expect(both.lines).toHaveLength(2);
    const r = calculatePortersPrice(input({ now: saturdayNow, startAt: new Date("2026-11-14T12:00:00Z") }), makeConfig());
    expect(r.ok && r.quote.subtotalCents).toBe(18_000 + 5400 + 3600);
  });

  it("fixed surcharge = amount once per job; disabled rule = no line", () => {
    const fixed = withRule(makeConfig(), "surcharge_weekend_holiday", { kind: "fixed", amountCents: 2500, percentBp: null });
    expect(ok({ startAt: new Date("2026-11-14T08:00:00Z") }, fixed).quote.subtotalCents).toBe(18_000 + 2500);
    const off = withRule(makeConfig(), "surcharge_weekend_holiday", { isEnabled: false });
    expect(ok({ startAt: new Date("2026-11-14T08:00:00Z") }, off).quote.subtotalCents).toBe(18_000);
  });

  it("address outside the service area, too soon, service disabled", () => {
    expect(calculatePortersPrice(input({ province: "rm" }), makeConfig())).toEqual({ ok: false, error: { code: "pickup_province", legIndex: 0, province: "RM" } });
    expect(calculatePortersPrice(input({ startAt: new Date(NOW.getTime() + 3_600_000) }), makeConfig())).toEqual({ ok: false, error: { code: "too_soon", legIndex: 0 } });
    expect(calculatePortersPrice(input(), makeConfig({ portersService: null }))).toEqual({ ok: false, error: { code: "service_unavailable", service: "porters" } });
    expect(calculatePortersPrice(input(), withRule(makeConfig(), "porter_hour", { isEnabled: false }))).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
  });

  it("job terms settle overtime like transport porters (D68)", () => {
    const { job } = ok();
    expect(job).toMatchObject({ persons: 2, includedHours: 3, overtimeRatePerPersonCents: 3500, overtimeGraceMinutes: 15, carrierShare: { kind: "percent", percentBp: 8000 } });
    const over = porterOvertimeCost({ workedMinutes: 3 * 60 + 16, terms: job, vatRateBp: 2200 });
    expect(over).toMatchObject({ ok: true, overtimeHours: 1, netCents: 7000, carrierAmountCents: 5600 });
  });
});
