// Public price data of the active price list (D162) and the browser mini calculators of the home page
// (Facchini, Deposito). Pure — no server imports, so the calculators can run in the browser.
//
// What leaves the server: customer rates only (net, VAT added here). Never carrier shares, overtime terms,
// the price list id, the service area or holidays. The calculators reuse the engine's own functions
// (calculatePortersPrice, calculateStoragePrice) on a config rebuilt from these public rates, so the
// indicative price follows exactly the same arithmetic as the real quote. "Prezzo indicativo": without
// the urgent and weekend/holiday surcharges, which depend on the date (D159) and are added by the wizard.

import { applyBp } from "@/lib/pricing/money";
import { calculatePortersPrice, PORTERS_MAX_FLOOR, PORTERS_MAX_HOURS, PORTERS_MAX_PERSONS } from "@/lib/pricing/porters-service";
import { calculateStoragePrice } from "@/lib/pricing/storage-service";
import type { CustomerType, PriceRule, PriceRuleCode, PricingConfig } from "@/lib/pricing/types";

export type PublicSurcharge = { kind: "percent"; percentBp: number } | { kind: "fixed"; amountCents: number };

export type PublicRates = {
  vatRateBp: number;
  transport: {
    vehicles: { vehicleTypeId: string; name: string; perKmCents: number; minCents: number }[];
    floorNoElevatorCents: number | null;
    urgentLeadHours: number;
    urgent: PublicSurcharge | null;
    weekendHoliday: PublicSurcharge | null;
  };
  /** Porters-only service (D157); null = not bookable with the active price list. */
  porters: {
    perHourCents: number;
    minPersons: number;
    maxPersons: number;
    minHours: number;
    maxHours: number;
    maxFloor: number;
    floorNoElevatorCents: number | null;
  } | null;
  /** Storage (D154); null = no active warehouse. */
  storage: {
    boxes: { code: string; label: string; volumeM3: number; dayCents: number; monthCents: number }[];
    /** Businesses, per pallet-day (D55); null = pallet storage not offered. */
    pallets: { shortDayCents: number; longDayCents: number | null; shortTermMaxDays: number; transshipmentCents: number | null } | null;
  } | null;
};

export const PALLETS_MAX = 100;
export const STORAGE_MAX_DAYS = 3650;

function ruleMap(rules: PriceRule[]) {
  const m = new Map<PriceRuleCode, PriceRule>();
  for (const r of rules) if (r.isEnabled) m.set(r.code, r);
  return m;
}

function surcharge(r: PriceRule | undefined): PublicSurcharge | null {
  if (!r) return null;
  if (r.kind === "percent") return r.percentBp ? { kind: "percent", percentBp: r.percentBp } : null;
  return r.amountCents ? { kind: "fixed", amountCents: r.amountCents } : null;
}

/**
 * Public rates of `config`. `vehicleIds`: vehicles the customer can actually book (active, priced);
 * `warehouseActive`: storage needs an active warehouse.
 */
export function toPublicRates(config: PricingConfig, opts: { vehicleIds: string[]; warehouseActive: boolean }): PublicRates {
  const rules = ruleMap(config.rules);
  const amount = (code: PriceRuleCode) => rules.get(code)?.amountCents ?? null;
  const bookable = new Set(opts.vehicleIds);
  const perHour = amount("porter_hour");
  const ps = config.portersService;
  const boxes = config.storageBoxes
    .filter((b) => b.isEnabled)
    .map((b) => ({ code: b.code, label: b.labelIt, volumeM3: b.volumeM3, dayCents: b.dayCents, monthCents: b.monthCents }));
  const palletDay = amount("storage_pallet_day");

  return {
    vatRateBp: config.vatRateBp,
    transport: {
      vehicles: config.vehicleRates
        .filter((v) => bookable.has(v.vehicleTypeId))
        .map((v) => ({ vehicleTypeId: v.vehicleTypeId, name: v.nameIt, perKmCents: v.ratePerKmCents, minCents: v.minPriceCents })),
      floorNoElevatorCents: amount("surcharge_floor_no_elevator"),
      urgentLeadHours: config.urgentLeadHours,
      urgent: surcharge(rules.get("surcharge_urgent")),
      weekendHoliday: surcharge(rules.get("surcharge_weekend_holiday")),
    },
    porters:
      ps && perHour !== null
        ? {
            perHourCents: perHour,
            minPersons: ps.minPersons,
            maxPersons: PORTERS_MAX_PERSONS,
            minHours: ps.minHours,
            maxHours: PORTERS_MAX_HOURS,
            maxFloor: PORTERS_MAX_FLOOR,
            floorNoElevatorCents: ps.floorNoElevatorCents,
          }
        : null,
    storage: opts.warehouseActive
      ? {
          boxes,
          pallets:
            palletDay !== null
              ? { shortDayCents: palletDay, longDayCents: amount("storage_pallet_day_long"), shortTermMaxDays: config.storageShortTermMaxDays, transshipmentCents: amount("transshipment_flat") }
              : null,
        }
      : null,
  };
}

/** Net + VAT (D56: round half up). */
export function withVat(netCents: number, vatRateBp: number): number {
  return netCents + applyBp(netCents, vatRateBp);
}

export type Estimate = { netCents: number; vatCents: number; grossCents: number; lines: { label: string; netCents: number }[] };

// A config holding only the public rates — enough for the engine's porters and storage functions.
const ESTIMATE_PROVINCE = "XX";
function estimateConfig(rates: PublicRates): PricingConfig {
  const r = (code: PriceRuleCode, amountCents: number | null): PriceRule[] =>
    amountCents === null ? [] : [{ code, kind: "per_unit", amountCents, percentBp: null, isEnabled: true }];
  return {
    priceListId: "public",
    priceListVersion: 0,
    vatRateBp: rates.vatRateBp,
    urgentLeadHours: 0,
    storageShortTermMaxDays: rates.storage?.pallets?.shortTermMaxDays ?? 30,
    storageBillingUnit: "pallet_day",
    porterOvertimeGraceMinutes: 0,
    porterPackages: [],
    portersService: rates.porters
      ? { minPersons: rates.porters.minPersons, minHours: rates.porters.minHours, floorNoElevatorCents: rates.porters.floorNoElevatorCents }
      : null,
    storageBoxes: (rates.storage?.boxes ?? []).map((b) => ({ code: b.code, labelIt: b.label, volumeM3: b.volumeM3, dayCents: b.dayCents, monthCents: b.monthCents, isEnabled: true })),
    vehicleRates: [],
    // No surcharges and no carrier shares: the estimate is the base price (see the header).
    rules: [
      ...r("porter_hour", rates.porters?.perHourCents ?? null),
      ...r("storage_pallet_day", rates.storage?.pallets?.shortDayCents ?? null),
      ...r("storage_pallet_day_long", rates.storage?.pallets?.longDayCents ?? null),
      ...r("transshipment_flat", rates.storage?.pallets?.transshipmentCents ?? null),
    ],
    holidays: [],
    serviceAreaProvinces: [ESTIMATE_PROVINCE],
    maxRouteDistanceM: 0,
    minBookingLeadHours: 0,
  };
}

// Fixed weekday dates: the engine needs a start time; no surcharge rule is present anyway.
const ESTIMATE_NOW = new Date("2030-01-08T08:00:00Z"); // Tuesday
const ESTIMATE_START = new Date("2030-01-15T08:00:00Z"); // Tuesday

export type PortersEstimateInput = { persons: number; hours: number; floor: number; hasElevator: boolean };

export function portersEstimate(rates: PublicRates, input: PortersEstimateInput, customerType: CustomerType = "private"): Estimate | null {
  if (!rates.porters) return null;
  const res = calculatePortersPrice(
    { customerType, now: ESTIMATE_NOW, startAt: ESTIMATE_START, province: ESTIMATE_PROVINCE, ...input },
    estimateConfig(rates),
  );
  if (!res.ok) return null;
  const q = res.quote;
  return { netCents: q.subtotalCents, vatCents: q.vatCents, grossCents: q.totalCents, lines: q.lines.map((l) => ({ label: l.labelIt, netCents: l.netCents })) };
}

export type StorageEstimateInput = { days: number } & ({ unit: "box"; boxCode: string } | { unit: "pallet"; pallets: number });

export function storageEstimate(rates: PublicRates, input: StorageEstimateInput, customerType: CustomerType = "private"): Estimate | null {
  if (!rates.storage) return null;
  // The calculator offers storage only (≥ 1 day); transshipment (0 days) exists only inside a chain (D153).
  if (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > STORAGE_MAX_DAYS) return null;
  if (input.unit === "pallet" && (!Number.isSafeInteger(input.pallets) || input.pallets < 1 || input.pallets > PALLETS_MAX)) return null;
  const res = calculateStoragePrice({ customerType, ...input }, estimateConfig(rates));
  if (!res.ok) return null;
  const q = res.quote;
  return { netCents: q.subtotalCents, vatCents: q.vatCents, grossCents: q.totalCents, lines: q.lines.map((l) => ({ label: l.labelIt, netCents: l.netCents })) };
}

/** Which services can be booked / requested with the active price list. */
export function publicAvailability(rates: PublicRates | null) {
  return {
    trasporto: !!rates && rates.transport.vehicles.length > 0,
    facchinaggio: !!rates?.porters,
    deposito: !!rates?.storage && (rates.storage.boxes.length > 0 || !!rates.storage.pallets),
  };
}
