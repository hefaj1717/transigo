import "server-only";
import { cacheLife } from "next/cache";
import { loadBookingOptions } from "@/lib/booking/server";
import { createServiceClient } from "@/lib/supabase/service";
import { toCompanyInfo, type CompanyInfo } from "./company";

// Data for the public pages. Nothing here depends on the visitor, so it is cached ('use cache') and becomes
// part of the prerendered pages; it is read with the service role because `settings`, `vehicle_types` and the
// price list are not readable by anonymous visitors (D59). Only public fields leave these functions.

export async function getCompanyInfo(): Promise<CompanyInfo> {
  "use cache";
  cacheLife("hours");
  try {
    const { data, error } = await createServiceClient()
      .from("settings")
      .select("company_name, company_vat_number, company_street, company_city, company_postal_code, company_province, company_email, company_phone, company_pec")
      .single();
    if (error) throw error;
    return toCompanyInfo(data);
  } catch (e) {
    console.error("[public] company info:", e instanceof Error ? e.message : e);
    return toCompanyInfo(null);
  }
}

export type PublicVehicle = {
  id: string;
  name: string;
  payloadKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  volumeM3: number | null; // one decimal
  euroPallets: number | null;
};

export type PublicCatalog = {
  bookingAvailable: boolean;
  vehicles: PublicVehicle[];
  portersAvailable: boolean;
  packingAvailable: boolean;
  storageAvailable: boolean;
  /** Load categories with persons and hours included in the price (D67) — no prices. */
  porterPackages: { code: string; label: string; persons: number; includedHours: number }[];
  /** Short-term storage limit (D117: no long-term storage offered for now). */
  storageMaxDays: number;
  storageBillingUnit: "day" | "pallet_day";
  warehouseCity: string | null;
  maxDistanceKm: number;
  minLeadHours: number;
};

/** Active, priced vehicle types and available services — capacities only, never prices or carrier terms. */
export async function getPublicCatalog(): Promise<PublicCatalog> {
  "use cache";
  cacheLife("hours");
  try {
    const o = await loadBookingOptions(createServiceClient());
    return {
      bookingAvailable: o.available,
      vehicles: o.vehicles.map((v) => ({
        id: v.id,
        name: v.nameIt,
        payloadKg: v.payloadKg,
        lengthCm: v.lengthCm,
        widthCm: v.widthCm,
        heightCm: v.heightCm,
        volumeM3: v.volumeDm3 == null ? null : Math.round(v.volumeDm3 / 100) / 10, // dm³ → m³, 1 decimal
        euroPallets: v.euroPallets,
      })),
      portersAvailable: o.porterPackages.length > 0,
      porterPackages: o.porterPackages.map((p) => ({ code: p.code, label: p.labelIt, persons: p.persons, includedHours: p.includedHours })),
      packingAvailable: o.packingAvailable,
      storageAvailable: o.storage.available,
      storageMaxDays: o.storage.maxDays,
      storageBillingUnit: o.storage.billingUnit,
      warehouseCity: o.storage.warehouseCity,
      maxDistanceKm: o.maxDistanceKm,
      minLeadHours: o.minLeadHours,
    };
  } catch (e) {
    console.error("[public] catalog:", e instanceof Error ? e.message : e);
    return { bookingAvailable: false, vehicles: [], portersAvailable: false, porterPackages: [], packingAvailable: false, storageAvailable: false, storageMaxDays: 0, storageBillingUnit: "pallet_day", warehouseCity: null, maxDistanceKm: 0, minLeadHours: 0 };
  }
}
