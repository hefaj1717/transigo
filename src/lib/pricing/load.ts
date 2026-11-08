import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toPricingConfig, type PorterPackageRow, type PriceListRow, type PriceRuleRow, type PricingSettingsRow, type VehicleRateRow } from "./config-from-db";
import type { PricingConfig } from "./types";

// Loads everything calculatePrice needs. Price tables and settings are admin-only (D59), so public
// quotes (Stage 2b) pass the service-role client; admin screens may pass the admin's own client.

export const PRICE_LIST_COLUMNS =
  "id, version, status, vat_rate_bp, urgent_lead_hours, storage_short_term_max_days, storage_billing_unit, porter_overtime_grace_minutes, notes, published_at";

export class PricingConfigError extends Error {}

export async function loadPricingConfig(db: SupabaseClient, priceListId?: string): Promise<PricingConfig> {
  const listQuery = db.from("price_lists").select(PRICE_LIST_COLUMNS);
  const { data: list, error: listError } = await (priceListId ? listQuery.eq("id", priceListId) : listQuery.eq("status", "active")).maybeSingle<PriceListRow>();
  if (listError) throw new PricingConfigError(`price list: ${listError.message}`);
  if (!list) throw new PricingConfigError(priceListId ? "price list not found" : "no active price list");

  const today = new Date().toISOString().slice(0, 10);
  const [rates, rules, packages, holidays, provinces, settings] = await Promise.all([
    db.from("price_list_vehicle_rates").select("vehicle_type_id, rate_per_km_cents, min_price_cents, vehicle_types(name_it, is_active, size_rank)").eq("price_list_id", list.id).returns<VehicleRateRow[]>(),
    db.from("price_rules").select("code, kind, amount_cents, percent_bp, is_enabled").eq("price_list_id", list.id).returns<PriceRuleRow[]>(),
    db.from("price_list_porter_packages").select("code, porters_count, included_hours, is_enabled").eq("price_list_id", list.id).returns<PorterPackageRow[]>(),
    // Holidays from yesterday on are enough for quotes (pickup is always in the future).
    db.from("holidays").select("date").gte("date", new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10)),
    db.from("service_area_provinces").select("province_code").eq("is_active", true),
    db.from("settings").select("max_route_distance_m, min_booking_lead_hours").single<PricingSettingsRow>(),
  ]);
  for (const [name, r] of Object.entries({ rates, rules, packages, holidays, provinces, settings })) {
    if (r.error) throw new PricingConfigError(`${name}: ${r.error.message}`);
  }

  return toPricingConfig({
    list,
    rates: rates.data ?? [],
    rules: rules.data ?? [],
    packages: packages.data ?? [],
    holidays: holidays.data ?? [],
    provinces: provinces.data ?? [],
    settings: settings.data!,
  });
}
