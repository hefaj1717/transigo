import { PORTER_PACKAGE_CODES, PRICE_RULE_CODES, type PorterPackage, type PorterPackageCode, type PriceRule, type PriceRuleCode, type PriceRuleKind, type PricingConfig, type StorageBillingUnit, type StorageBox } from "./types";

// Pure mapping from database rows (snake_case, as returned by Supabase) to PricingConfig.

export type PriceListRow = {
  id: string;
  version: number;
  status: "draft" | "active" | "archived";
  vat_rate_bp: number;
  urgent_lead_hours: number;
  storage_short_term_max_days: number;
  storage_billing_unit: StorageBillingUnit;
  porter_overtime_grace_minutes: number;
  porters_min_hours: number;
  porters_min_persons: number;
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

export type PorterPackageRow = { code: string; porters_count: number; included_hours: number; is_enabled: boolean };

export type StorageBoxRow = {
  code: string;
  label_it: string;
  volume_m3: number | string; // numeric(5,2); PostgREST may send it as a string
  day_cents: number;
  month_cents: number;
  sort_order: number;
  is_enabled: boolean;
};

export type PricingSettingsRow = { max_route_distance_m: number; min_booking_lead_hours: number };

export function toPricingConfig(input: {
  list: PriceListRow;
  rates: VehicleRateRow[];
  rules: PriceRuleRow[];
  packages?: PorterPackageRow[];
  boxes?: StorageBoxRow[];
  holidays: { date: string }[];
  provinces: { province_code: string }[];
  settings: PricingSettingsRow;
}): PricingConfig {
  const known = new Set<string>(PRICE_RULE_CODES);
  const rules: PriceRule[] = input.rules
    .filter((r) => known.has(r.code))
    .map((r) => ({ code: r.code as PriceRuleCode, kind: r.kind, amountCents: r.amount_cents, percentBp: r.percent_bp, isEnabled: r.is_enabled }));

  const packageCodes = new Set<string>(PORTER_PACKAGE_CODES);
  const porterPackages: PorterPackage[] = (input.packages ?? [])
    .filter((p) => packageCodes.has(p.code))
    .map((p) => ({ code: p.code as PorterPackageCode, portersCount: p.porters_count, includedHours: p.included_hours, isEnabled: p.is_enabled }));

  // The porters-only service (D151, D157) exists only in lists that carry its floor rule (created by the
  // pricing_services migration or "Crea bozza"); a disabled rule means no floor surcharge.
  const floorRule = input.rules.find((r) => r.code === "porters_floor_no_elevator");
  const portersService = floorRule
    ? {
        minPersons: input.list.porters_min_persons,
        minHours: input.list.porters_min_hours,
        floorNoElevatorCents: floorRule.is_enabled ? floorRule.amount_cents : null,
      }
    : null;

  // Disabled boxes are kept: the engine rejects them, the admin preview still lists them.
  const storageBoxes: StorageBox[] = [...(input.boxes ?? [])]
    .map((b) => ({ ...b, volume: Number(b.volume_m3) }))
    .sort((a, b) => a.sort_order - b.sort_order || a.volume - b.volume || a.code.localeCompare(b.code))
    .map((b) => ({ code: b.code, labelIt: b.label_it, volumeM3: b.volume, dayCents: b.day_cents, monthCents: b.month_cents, isEnabled: b.is_enabled }));

  return {
    priceListId: input.list.id,
    priceListVersion: input.list.version,
    vatRateBp: input.list.vat_rate_bp,
    urgentLeadHours: input.list.urgent_lead_hours,
    storageShortTermMaxDays: input.list.storage_short_term_max_days,
    storageBillingUnit: input.list.storage_billing_unit,
    porterOvertimeGraceMinutes: input.list.porter_overtime_grace_minutes,
    porterPackages,
    portersService,
    storageBoxes,
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
