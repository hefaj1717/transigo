import { PRICE_RULE_CODES, type PriceRule, type PriceRuleCode, type PriceRuleKind, type PricingConfig, type StorageBillingUnit } from "./types";

// Pure mapping from database rows (snake_case, as returned by Supabase) to PricingConfig.

export type PriceListRow = {
  id: string;
  version: number;
  status: "draft" | "active" | "archived";
  vat_rate_bp: number;
  urgent_lead_hours: number;
  storage_short_term_max_days: number;
  storage_billing_unit: StorageBillingUnit;
  notes: string | null;
  published_at: string | null;
};

export type VehicleRateRow = {
  vehicle_type_id: string;
  rate_per_km_cents: number;
  min_price_cents: number;
  vehicle_types: { name_it: string; is_active: boolean; size_rank: number } | null;
};

export type PriceRuleRow = {
  code: string;
  kind: PriceRuleKind;
  amount_cents: number | null;
  percent_bp: number | null;
  is_enabled: boolean;
};

export type PricingSettingsRow = { max_route_distance_m: number; min_booking_lead_hours: number };

export function toPricingConfig(input: {
  list: PriceListRow;
  rates: VehicleRateRow[];
  rules: PriceRuleRow[];
  holidays: { date: string }[];
  provinces: { province_code: string }[];
  settings: PricingSettingsRow;
}): PricingConfig {
  const known = new Set<string>(PRICE_RULE_CODES);
  const rules: PriceRule[] = input.rules
    .filter((r) => known.has(r.code))
    .map((r) => ({ code: r.code as PriceRuleCode, kind: r.kind, amountCents: r.amount_cents, percentBp: r.percent_bp, isEnabled: r.is_enabled }));

  return {
    priceListId: input.list.id,
    priceListVersion: input.list.version,
    vatRateBp: input.list.vat_rate_bp,
    urgentLeadHours: input.list.urgent_lead_hours,
    storageShortTermMaxDays: input.list.storage_short_term_max_days,
    storageBillingUnit: input.list.storage_billing_unit,
    // Only active vehicle types can be quoted.
    vehicleRates: input.rates
      .filter((r) => r.vehicle_types?.is_active)
      .sort((a, b) => (a.vehicle_types?.size_rank ?? 0) - (b.vehicle_types?.size_rank ?? 0))
      .map((r) => ({
        vehicleTypeId: r.vehicle_type_id,
        nameIt: r.vehicle_types?.name_it ?? "",
        ratePerKmCents: r.rate_per_km_cents,
        minPriceCents: r.min_price_cents,
      })),
    rules,
    holidays: input.holidays.map((h) => h.date),
    serviceAreaProvinces: input.provinces.map((p) => p.province_code),
    maxRouteDistanceM: input.settings.max_route_distance_m,
    minBookingLeadHours: input.settings.min_booking_lead_hours,
  };
}
