import type { PriceLeg, PriceRule, PriceRuleCode, PricingConfig } from "../types";

// Test configuration mirroring the seeded price list v1 (supabase/migrations/*_pricing.sql).

export const V = {
  car: "vt-car",
  vanSmall: "vt-van-small",
  vanMedium: "vt-van-medium",
  vanLarge: "vt-van-large",
  truck: "vt-truck",
} as const;

const rule = (code: PriceRuleCode, kind: PriceRule["kind"], value: number): PriceRule => ({
  code,
  kind,
  amountCents: kind === "percent" ? null : value,
  percentBp: kind === "percent" ? value : null,
  isEnabled: true,
});

export function makeConfig(overrides: Partial<PricingConfig> = {}): PricingConfig {
  return {
    priceListId: "pl-1",
    priceListVersion: 1,
    vatRateBp: 2200,
    urgentLeadHours: 24,
    storageShortTermMaxDays: 30,
    storageBillingUnit: "pallet_day",
    porterOvertimeGraceMinutes: 15,
    porterPackages: [
      { code: "parcels", portersCount: 1, includedHours: 1, isEnabled: true },
      { code: "monolocale", portersCount: 2, includedHours: 2, isEnabled: true },
      { code: "bilocale", portersCount: 2, includedHours: 3, isEnabled: true },
      { code: "trilocale_plus", portersCount: 3, includedHours: 4, isEnabled: true },
    ],
    vehicleRates: [
      { vehicleTypeId: V.car, nameIt: "Auto / station wagon", ratePerKmCents: 90, minPriceCents: 3500 },
      { vehicleTypeId: V.vanSmall, nameIt: "Furgone piccolo", ratePerKmCents: 110, minPriceCents: 4500 },
      { vehicleTypeId: V.vanMedium, nameIt: "Furgone medio", ratePerKmCents: 140, minPriceCents: 6000 },
      { vehicleTypeId: V.vanLarge, nameIt: "Furgone grande 3,5 t", ratePerKmCents: 170, minPriceCents: 8000 },
      { vehicleTypeId: V.truck, nameIt: "Camion con sponda idraulica", ratePerKmCents: 220, minPriceCents: 12000 },
    ],
    rules: [
      rule("surcharge_urgent", "percent", 3000),
      rule("surcharge_weekend_holiday", "percent", 2000),
      rule("surcharge_floor_no_elevator", "per_unit", 1000),
      rule("porter_hour", "per_unit", 3000),
      rule("porter_overtime_hour", "per_unit", 3500),
      rule("packing_flat", "fixed", 1500),
      rule("packing_per_item", "per_unit", 500),
      rule("storage_day", "per_unit", 800),
      rule("storage_pallet_day", "per_unit", 300),
      rule("storage_day_long", "per_unit", 500),
      rule("storage_pallet_day_long", "per_unit", 200),
      rule("transshipment_flat", "fixed", 2500),
      rule("carrier_share_transport", "percent", 7000),
      rule("carrier_share_porters", "percent", 8000),
      rule("carrier_share_packing", "percent", 6000),
    ],
    holidays: ["2026-06-02", "2026-11-01", "2026-12-08", "2026-12-25", "2026-12-26"],
    serviceAreaProvinces: ["MI", "MB", "TO"],
    maxRouteDistanceM: 300_000,
    minBookingLeadHours: 3,
    ...overrides,
  };
}

/** Replaces (or disables) one rule. */
export function withRule(config: PricingConfig, code: PriceRuleCode, patch: Partial<PriceRule>): PricingConfig {
  return { ...config, rules: config.rules.map((r) => (r.code === code ? { ...r, ...patch } : r)) };
}

// Monday 9 Nov 2026, 08:00 UTC (09:00 in Rome).
export const NOW = new Date("2026-11-09T08:00:00Z");
// Wednesday 11 Nov 2026, 08:00 UTC — 48 h later: not urgent, weekday.
export const WEEKDAY = new Date("2026-11-11T08:00:00Z");

export function leg(overrides: Partial<PriceLeg> = {}): PriceLeg {
  return {
    distanceM: 50_000,
    vehicleTypeId: V.car,
    pickupAt: WEEKDAY,
    pickupProvince: "MI",
    pickupFloor: 0,
    pickupHasElevator: false,
    deliveryFloor: 0,
    deliveryHasElevator: false,
    ...overrides,
  };
}
