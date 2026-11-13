import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toPricingConfig, type PorterPackageRow, type PriceListRow, type PriceRuleRow, type PricingSettingsRow, type StorageBoxRow, type VehicleRateRow } from "./config-from-db";
import type { PricingConfig } from "./types";

// Loads everything calculatePrice needs. Price tables and settings are admin-only (D59), so public
// quotes (Stage 2b) pass the service-role client; admin screens may pass the admin's own client.

export const PRICE_LIST_COLUMNS =
  "id, version, status, vat_rate_bp, urgent_lead_hours, storage_short_term_max_days, storage_billing_unit, porter_overtime_grace_minutes, porters_min_hours, porters_min_persons, notes, published_at";

export class PricingConfigError extends Error {}

type PriceListWithChildren = PriceListRow & {
  price_list_vehicle_rates: VehicleRateRow[] | null;
  price_rules: PriceRuleRow[] | null;
  price_list_porter_packages: PorterPackageRow[] | null;
  price_list_storage_boxes: StorageBoxRow[] | null;
};

export async function loadPricingConfig(db: SupabaseClient, priceListId?: string): Promise<PricingConfig> {
  // One round trip for the list and its children (embedded by price_list_id), in parallel with the shared tables.
  const listQuery = db
    .from("price_lists")
    .select(
      `${PRICE_LIST_COLUMNS}, ` +
        "price_list_vehicle_rates(vehicle_type_id, rate_per_km_cents, min_price_cents, vehicle_types(name_it, is_active, size_rank)), " +
        "price_rules(code, kind, amount_cents, percent_bp, is_enabled), " +
        "price_list_porter_packages(code, porters_count, included_hours, is_enabled), " +
        "price_list_storage_boxes(code, label_it, volume_m3, day_cents, month_cents, sort_order, is_enabled)",
    );
  const today = new Date().toISOString().slice(0, 10);
  const [listResult, holidays, provinces, settings] = await Promise.all([
    (priceListId ? listQuery.eq("id", priceListId) : listQuery.eq("status", "active")).maybeSingle<PriceListWithChildren>(),
    // Holidays from yesterday on are enough for quotes (pickup is always in the future).
    db.from("holidays").select("date").gte("date", new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10)),
    db.from("service_area_provinces").select("province_code").eq("is_active", true),
    db.from("settings").select("max_route_distance_m, min_booking_lead_hours").single<PricingSettingsRow>(),
  ]);
  if (listResult.error) throw new PricingConfigError(`price list: ${listResult.error.message}`);
  const full = listResult.data;
  if (!full) throw new PricingConfigError(priceListId ? "price list not found" : "no active price list");
  for (const [name, r] of Object.entries({ holidays, provinces, settings })) {
    if (r.error) throw new PricingConfigError(`${name}: ${r.error.message}`);
  }
  const {
    price_list_vehicle_rates: rates,
    price_rules: rules,
    price_list_porter_packages: packages,
    price_list_storage_boxes: boxes,
    ...list
  } = full;

  return toPricingConfig({
    list,
    rates: rates ?? [],
    rules: rules ?? [],
    packages: packages ?? [],
    boxes: boxes ?? [],
    holidays: holidays.data ?? [],
    provinces: provinces.data ?? [],
    settings: settings.data!,
  });
}
