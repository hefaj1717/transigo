import { isWeekendOrHoliday } from "./calendar";
import { applyBp } from "./money";
import { enabledRules, finalizeLines, porterShareTerms, type DraftLine } from "./finalize";
import type { CustomerType, PricingConfig, PricingError, Quote, QuotePorters } from "./types";

// Porters-only service — "Facchinaggio" without transport (D151, D152, D157). Pure.
//
//   porters = persons × max(hours, minHours) × porter_hour
//   floors  = floor × porters_floor_no_elevator   (0 with an elevator or at the ground floor)
//
// Urgent (start < urgentLeadHours away, D49) and weekend / holiday (start date in Europe/Rome, D51)
// surcharges use the same rules as transport (D159): percentage of the porters line (after the minimum
// hours, without floors — like D52), or the fixed amount once per job; both add up.
// All lines belong to the carrier's porters group (carrier_share_porters, D57). Overtime after the job
// as for transport porters (D68): the terms are returned with the quote and stored with the order.

const HOUR_MS = 3_600_000;
export const PORTERS_MAX_PERSONS = 4; // D54
export const PORTERS_MAX_HOURS = 12;
export const PORTERS_MAX_FLOOR = 20; // D53

export type PortersPriceInput = {
  customerType: CustomerType;
  now: Date;
  startAt: Date; // start of the time window (D73)
  province: string; // sigla of the job address — must be in the service area (D13)
  persons: number;
  hours: number; // estimated by the customer; billed at least minHours
  floor: number;
  hasElevator: boolean;
};

/** Overtime terms of the job (same shape as transport porters, without the load category). */
export type PortersJobTerms = Omit<QuotePorters, "legIndex" | "packageCode">;

export type PortersPriceResult = { ok: true; quote: Quote; job: PortersJobTerms } | { ok: false; error: PricingError };

const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;

export function calculatePortersPrice(input: PortersPriceInput, config: PricingConfig): PortersPriceResult {
  const fail = (error: PricingError): PortersPriceResult => ({ ok: false, error });
  const invalid = (message: string) => fail({ code: "invalid_input", message });

  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) return invalid("now must be a valid date");
  if (!(input.startAt instanceof Date) || Number.isNaN(input.startAt.getTime())) return invalid("startAt must be a valid date");
  if (!isInt(input.floor, 0, PORTERS_MAX_FLOOR)) return invalid(`floor must be 0–${PORTERS_MAX_FLOOR}`);

  const rules = enabledRules(config.rules);
  const perHour = rules.get("porter_hour")?.amountCents ?? null;
  const service = config.portersService;
  if (!service || perHour === null) return fail({ code: "service_unavailable", service: "porters" });

  if (!isInt(input.persons, service.minPersons, PORTERS_MAX_PERSONS)) return invalid(`persons must be ${service.minPersons}–${PORTERS_MAX_PERSONS}`);
  if (!isInt(input.hours, 1, PORTERS_MAX_HOURS)) return invalid(`hours must be 1–${PORTERS_MAX_HOURS}`);

  const province = input.province.trim().toUpperCase();
  if (!config.serviceAreaProvinces.some((p) => p.toUpperCase() === province)) {
    return fail({ code: "pickup_province", legIndex: 0, province });
  }
  if (input.startAt.getTime() - input.now.getTime() < config.minBookingLeadHours * HOUR_MS) {
    return fail({ code: "too_soon", legIndex: 0 });
  }

  // Fewer hours than the minimum are billed as the minimum; the label says so.
  const hours = Math.max(input.hours, service.minHours);
  const personHours = input.persons * hours;
  const portersNet = personHours * perHour;
  const lines: DraftLine[] = [
    {
      lineType: "porters",
      labelIt: `Facchinaggio: ${input.persons} ${input.persons === 1 ? "persona" : "persone"} × ${hours} h${hours > input.hours ? " (minimo)" : ""}`,
      legIndex: 0,
      quantity: personHours,
      unitAmountCents: perHour,
      netCents: portersNet,
      carrierShareGroup: "porters",
    },
  ];

  const surcharge = (code: "surcharge_urgent" | "surcharge_weekend_holiday", label: string) => {
    const rule = rules.get(code);
    if (!rule) return;
    const amount = rule.kind === "percent" ? applyBp(portersNet, rule.percentBp ?? 0) : (rule.amountCents ?? 0);
    if (amount > 0) {
      lines.push({ lineType: code, labelIt: label, legIndex: 0, quantity: 1, unitAmountCents: amount, netCents: amount, carrierShareGroup: "porters" });
    }
  };
  const urgent = input.startAt.getTime() - input.now.getTime() < config.urgentLeadHours * HOUR_MS;
  if (urgent) surcharge("surcharge_urgent", "Supplemento urgenza");
  if (isWeekendOrHoliday(input.startAt, new Set(config.holidays))) surcharge("surcharge_weekend_holiday", "Supplemento weekend/festivo");

  const floors = input.hasElevator ? 0 : input.floor;
  const perFloor = service.floorNoElevatorCents;
  if (floors > 0 && perFloor !== null && perFloor > 0) {
    lines.push({
      lineType: "porters_floors",
      labelIt: `Piani senza ascensore (${floors})`,
      legIndex: 0,
      quantity: floors,
      unitAmountCents: perFloor,
      netCents: floors * perFloor,
      carrierShareGroup: "porters",
    });
  }

  const final = finalizeLines(lines, rules, config.vatRateBp);
  const carrierAmountCents = final.lines.reduce((s, l) => s + l.carrierAmountCents, 0);

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
      carrierAmountCents,
      carrierAmountByLegCents: [carrierAmountCents],
      storageType: null,
      porters: [],
      isUrgentByLeg: [urgent],
      warnings: final.warnings,
    },
    job: {
      persons: input.persons,
      includedHours: hours,
      overtimeRatePerPersonCents: rules.get("porter_overtime_hour")?.amountCents ?? null,
      overtimeGraceMinutes: config.porterOvertimeGraceMinutes,
      // Floors are a flat surcharge, so the overtime share follows the porter_hour line only.
      carrierShare: porterShareTerms(rules, final.lines.filter((l) => l.lineType === "porters")),
    },
  };
}
