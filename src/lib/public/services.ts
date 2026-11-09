// Pure helpers of the service pages (/servizi/…): whether a service can be booked with the active price list
// and the texts completed with price-list values. Storage: short term only (D117).
import { SERVICE_DETAILS, type ServiceCode } from "./content";
import type { PublicCatalog } from "./server";

/** Whether the service can be booked online with the active price list. */
export function serviceAvailable(code: ServiceCode, c: PublicCatalog): boolean {
  if (!c.bookingAvailable) return false;
  switch (code) {
    case "trasporto":
      return c.vehicles.length > 0;
    case "facchinaggio":
      return c.portersAvailable;
    case "imballaggio":
      return c.packingAvailable;
    case "deposito-merci":
      return c.storageAvailable;
  }
}

/** Service texts completed with values from the price list (storage: short term only, D117). */
export function serviceTexts(code: ServiceCode, c: PublicCatalog): { includes: string[]; pricing: string[] } {
  const d = SERVICE_DETAILS[code];
  if (code !== "deposito-merci") return { includes: d.includes, pricing: d.pricing };
  const includes = d.includes.map((t, i) => (i === 1 && c.storageMaxDays > 0 ? `Deposito a breve termine, fino a ${c.storageMaxDays} giorni` : t));
  const unit = c.storageBillingUnit === "pallet_day" ? "Tariffa per pallet al giorno" : "Tariffa giornaliera";
  return { includes, pricing: [unit, ...d.pricing] };
}
