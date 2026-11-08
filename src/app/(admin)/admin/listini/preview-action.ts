"use server";

// Sample quote for the admin before publishing (spec 9: "podgląd przykładowej wyceny przed zapisem").
// Uses the selected price list (draft or not) with the real calculatePrice; the service-area check is
// bypassed with a placeholder province, the max distance and lead time from settings still apply.
import { adminAction } from "@/lib/admin/server";
import { calculatePrice } from "@/lib/pricing/calculate";
import { romeLocalToDate } from "@/lib/pricing/calendar";
import { loadPricingConfig, PricingConfigError } from "@/lib/pricing/load";
import { PORTER_PACKAGE_CODES, type PorterPackageCode, type PriceInput, type PricingError, type Quote } from "@/lib/pricing/types";

export type PreviewState = { quote?: Quote; error?: string };

const PREVIEW_PROVINCE = "ZZ";
const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();
const int = (fd: FormData, key: string) => {
  const s = str(fd, key);
  return s === "" ? 0 : /^\d{1,6}$/.test(s) ? Number(s) : NaN;
};

/** "143,122" / "143.122" km → 143122 m (at most 3 decimals, no floats). */
function kmToMetres(input: string): number | null {
  const m = /^(\d{1,4})(?:[.,](\d{1,3}))?$/.exec(input.trim());
  return m ? Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0")) : null;
}

const ERROR_TEXT: Record<PricingError["code"], string> = {
  pickup_province: "Provincia di ritiro fuori area.",
  max_distance: "Distanza oltre il massimo impostato in Area di servizio.",
  too_soon: "Ritiro troppo vicino: rispetta il preavviso minimo.",
  vehicle_not_priced: "Il veicolo non ha una tariffa in questo listino (o non è attivo).",
  service_unavailable: "Servizio disattivato in questo listino.",
  invalid_input: "Dati non validi",
};

export async function previewQuoteAction(_prev: PreviewState, fd: FormData): Promise<PreviewState> {
  const { db } = await adminAction();
  const distanceM = kmToMetres(str(fd, "distance_km"));
  const pickupAt = romeLocalToDate(str(fd, "pickup_at"));
  if (!distanceM || !pickupAt) return { error: "Inserisci distanza (km) e data di ritiro." };

  let config;
  try {
    config = await loadPricingConfig(db, str(fd, "id"));
  } catch (e) {
    return { error: e instanceof PricingConfigError ? "Listino non trovato." : "Errore nel caricamento del listino." };
  }
  config = { ...config, serviceAreaProvinces: [PREVIEW_PROVINCE] };

  const packageCode = str(fd, "porter_package");
  const hasPorters = (PORTER_PACKAGE_CODES as readonly string[]).includes(packageCode);
  const portersCount = str(fd, "porters_count");
  const packingItems = int(fd, "packing_items");
  const storageDays = str(fd, "storage_days");
  const input: PriceInput = {
    customerType: str(fd, "customer_type") === "business" ? "business" : "private",
    now: new Date(),
    legs: [
      {
        distanceM,
        vehicleTypeId: str(fd, "vehicle_type_id"),
        pickupAt,
        pickupProvince: PREVIEW_PROVINCE,
        pickupFloor: int(fd, "pickup_floor"),
        pickupHasElevator: fd.get("pickup_elevator") === "on",
        deliveryFloor: int(fd, "delivery_floor"),
        deliveryHasElevator: fd.get("delivery_elevator") === "on",
      },
    ],
    porters: hasPorters
      ? { packageCode: packageCode as PorterPackageCode, count: portersCount === "" ? undefined : int(fd, "porters_count") }
      : undefined,
    packing: packingItems > 0 ? { itemsCount: packingItems } : undefined,
    storage: storageDays !== "" ? { days: int(fd, "storage_days"), pallets: int(fd, "storage_pallets") || undefined } : undefined,
  };

  const result = calculatePrice(input, config);
  if (!result.ok) {
    const e = result.error;
    return { error: e.code === "invalid_input" ? `${ERROR_TEXT.invalid_input}: ${e.message}` : ERROR_TEXT[e.code] };
  }
  return { quote: result.quote };
}
