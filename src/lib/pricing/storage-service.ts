import { enabledRules, finalizeLines, type DraftLine } from "./finalize";
import { storageCost } from "./storage";
import type { CustomerType, PricingConfig, PricingError, Quote, StorageBox, StorageType } from "./types";

// Storage-only service — "Deposito" (D151, D154). Pure. 100 % Transigo (carrier group "none").
//
//   private customers: a box from the price list for a fixed number of days:
//     full 30-day months × monthCents + remaining days × dayCents,
//     the remaining days never cost more than one month (so 25 days of a box never exceed a month).
//   businesses: pallets × days with the short / long tiers of D55 (storageCost, billing per pallet-day);
//     0 days = transshipment (only inside a chain transport → warehouse → transport, D153).

export const STORAGE_MONTH_DAYS = 30;
const MAX_DAYS = 3650;

export type BoxCost = {
  months: number;
  restDays: number;
  monthsCents: number;
  restCents: number;
  /** true when the remaining days are billed as one month (day rate × days would be higher). */
  restCapped: boolean;
  totalCents: number;
};

/** Cost of one box for `days` (≥ 1) days. */
export function storageBoxCost(box: Pick<StorageBox, "dayCents" | "monthCents">, days: number): BoxCost {
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) throw new RangeError(`days must be 1–${MAX_DAYS}`);
  const months = Math.floor(days / STORAGE_MONTH_DAYS);
  const restDays = days % STORAGE_MONTH_DAYS;
  const byDay = restDays * box.dayCents;
  const restCapped = restDays > 0 && byDay > box.monthCents;
  const monthsCents = months * box.monthCents;
  const restCents = restCapped ? box.monthCents : byDay;
  return { months, restDays, monthsCents, restCents, restCapped, totalCents: monthsCents + restCents };
}

export type StoragePriceInput = { customerType: CustomerType; days: number } & (
  | { unit: "box"; boxCode: string }
  | { unit: "pallet"; pallets: number }
);

export type StoragePriceResult = { ok: true; quote: Quote } | { ok: false; error: PricingError };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function calculateStoragePrice(input: StoragePriceInput, config: PricingConfig): StoragePriceResult {
  const fail = (error: PricingError): StoragePriceResult => ({ ok: false, error });
  const unavailable = () => fail({ code: "service_unavailable", service: "storage" });
  const rules = enabledRules(config.rules);
  const lines: DraftLine[] = [];
  let storageType: StorageType;

  if (input.unit === "box") {
    if (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > MAX_DAYS) {
      return fail({ code: "invalid_input", message: `days must be 1–${MAX_DAYS}` });
    }
    const box = config.storageBoxes.find((b) => b.code === input.boxCode);
    if (!box || !box.isEnabled) return unavailable();
    const cost = storageBoxCost(box, input.days);
    const name = `${box.labelIt} (${box.volumeM3} m³)`;
    if (cost.months > 0) {
      lines.push({
        lineType: "storage",
        labelIt: `${name}: ${plural(cost.months, "mese", "mesi")}`,
        legIndex: null,
        quantity: cost.months,
        unitAmountCents: box.monthCents,
        netCents: cost.monthsCents,
        carrierShareGroup: "none",
      });
    }
    if (cost.restDays > 0) {
      const days = plural(cost.restDays, "giorno", "giorni");
      lines.push(
        cost.restCapped
          ? { lineType: "storage", labelIt: `${name}: ${days} (tariffa di 1 mese)`, legIndex: null, quantity: 1, unitAmountCents: box.monthCents, netCents: cost.restCents, carrierShareGroup: "none" }
          : { lineType: "storage", labelIt: `${name}: ${days}`, legIndex: null, quantity: cost.restDays, unitAmountCents: box.dayCents, netCents: cost.restCents, carrierShareGroup: "none" },
      );
    }
    storageType = input.days > config.storageShortTermMaxDays ? "long_term" : "short_term";
  } else {
    // Businesses are always billed per pallet-day (D154), whatever the transport option used (D55).
    const amountOf = (code: Parameters<typeof rules.get>[0]) => rules.get(code)?.amountCents ?? null;
    const result = storageCost({
      days: input.days,
      pallets: input.pallets,
      billingUnit: "pallet_day",
      shortTermMaxDays: config.storageShortTermMaxDays,
      rates: {
        transshipmentFlatCents: amountOf("transshipment_flat"),
        shortTermUnitCents: amountOf("storage_pallet_day"),
        longTermUnitCents: amountOf("storage_pallet_day_long"),
      },
    });
    if (!result.ok) return result.reason === "rate_disabled" ? unavailable() : fail({ code: "invalid_input", message: result.message });
    storageType = result.storageType;
    const pallets = plural(input.pallets, "pallet", "pallet");
    for (const s of result.segments) {
      lines.push({
        lineType: "storage",
        labelIt:
          s.tier === "transshipment"
            ? "Trasbordo in magazzino"
            : `Deposito ${s.tier === "short_term" ? "breve" : "lungo"} periodo, giorni ${s.fromDay}–${s.toDay}, ${pallets}`,
        legIndex: null,
        quantity: s.quantity,
        unitAmountCents: s.unitAmountCents,
        netCents: s.amountCents,
        carrierShareGroup: "none",
      });
    }
  }

  const final = finalizeLines(lines, rules, config.vatRateBp);
  return {
    ok: true,
    quote: {
      priceListId: config.priceListId,
      priceListVersion: config.priceListVersion,
      customerType: input.customerType,
      display: input.customerType === "private" ? "gross" : "net_plus_vat",
      vatRateBp: config.vatRateBp,
      lines: final.lines,
      subtotalCents: final.subtotalCents,
      vatCents: final.vatCents,
      totalCents: final.subtotalCents + final.vatCents,
      carrierAmountCents: 0,
      carrierAmountByLegCents: [],
      storageType,
      porters: [],
      isUrgentByLeg: [],
      warnings: final.warnings,
    },
  };
}
