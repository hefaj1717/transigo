import { describe, expect, it } from "vitest";
import { toPricingConfig } from "./config-from-db";

describe("toPricingConfig", () => {
  it("maps rows, keeps only active vehicle types sorted by size and ignores unknown rule codes", () => {
    const config = toPricingConfig({
      list: { id: "pl", version: 3, status: "active", vat_rate_bp: 2200, urgent_lead_hours: 24, storage_short_term_max_days: 30, storage_billing_unit: "day", notes: null, published_at: "2026-11-08T00:00:00Z" },
      rates: [
        { vehicle_type_id: "b", rate_per_km_cents: 140, min_price_cents: 6000, vehicle_types: { name_it: "Furgone medio", is_active: true, size_rank: 3 } },
        { vehicle_type_id: "a", rate_per_km_cents: 90, min_price_cents: 3500, vehicle_types: { name_it: "Auto", is_active: true, size_rank: 1 } },
        { vehicle_type_id: "x", rate_per_km_cents: 1, min_price_cents: 1, vehicle_types: { name_it: "Old", is_active: false, size_rank: 9 } },
      ],
      rules: [
        { code: "porter_hour", kind: "per_unit", amount_cents: 3000, percent_bp: null, is_enabled: true },
        { code: "future_code", kind: "fixed", amount_cents: 1, percent_bp: null, is_enabled: true },
      ],
      holidays: [{ date: "2026-12-25" }],
      provinces: [{ province_code: "MI" }],
      settings: { max_route_distance_m: 300000, min_booking_lead_hours: 3 },
    });
    expect(config.vehicleRates.map((v) => v.vehicleTypeId)).toEqual(["a", "b"]);
    expect(config.rules).toEqual([{ code: "porter_hour", kind: "per_unit", amountCents: 3000, percentBp: null, isEnabled: true }]);
    expect(config).toMatchObject({ priceListId: "pl", priceListVersion: 3, storageBillingUnit: "day", holidays: ["2026-12-25"], serviceAreaProvinces: ["MI"], maxRouteDistanceM: 300000 });
  });
});
