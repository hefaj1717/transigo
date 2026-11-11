import { enabledRules, finalizeLines, porterShareTerms, type DraftLine } from "./finalize";
import type { CustomerType, PricingConfig, PricingError, Quote, QuotePorters } from "./types";

// Porters-only service — "Facchinaggio" without transport (D151, D152, D157). Pure.
//
//   porters = persons × max(hours, minHours) × porter_hour
//   floors  = floor × porters_floor_no_elevator   (0 with an elevator or at the ground floor)
//
// Both lines belong to the carrier's porters group (carrier_share_porters, D57). No urgent / weekend
// surcharges (those are transport surcharges, D49–D52). Overtime after the job as for transport porters
// (D68): the terms are returned with the quote and stored with the order.

const HOUR_MS = 3_600_000;
const MAX_PERSONS = 4; // D54
const MAX_HOURS = 12;
const MAX_FLOOR = 20; // D53

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
  if (!isInt(input.floor, 0, MAX_FLOOR)) return invalid(`floor must be 0–${MAX_FLOOR}`);

  const rules = enabledRules(config.rules);
  const perHour = rules.get("porter_hour")?.amountCents ?? null;
  const service = config.portersService;
  if (!service || perHour === null) return fail({ code: "service_unavailable", service: "porters" });

  if (!isInt(input.persons, service.minPersons, MAX_PERSONS)) return invalid(`persons must be ${service.minPersons}–${MAX_PERSONS}`);
  if (!isInt(input.hours, 1, MAX_HOURS)) return invalid(`hours must be 1–${MAX_HOURS}`);

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
  const lines: DraftLine[] = [
    {
      lineType: "porters",
      labelIt: `Facchinaggio: ${input.persons} persone × ${hours} h${hours > input.hours ? " (minimo)" : ""}`,
      legIndex: 0,
      quantity: personHours,
      unitAmountCents: perHour,
      netCents: personHours * perHour,
      carrierShareGroup: "porters",
    },
  ];

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
      isUrgentByLeg: [false],
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
