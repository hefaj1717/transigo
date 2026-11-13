import { isWeekendOrHoliday } from "./calendar";
import { enabledRules, finalizeLines, porterShareTerms, type DraftLine } from "./finalize";
import { applyBp } from "./money";
import { PORTER_PACKAGE_LABEL } from "./rule-meta";
import { storageCost } from "./storage";
import { isLoadingHelp, LOADING_HELP_MAX_HOURS, PORTER_PACKAGE_CODES } from "./types";
import type {
  OrderLineType,
  PriceInput,
  PriceResult,
  PriceRuleCode,
  PricingConfig,
  PricingError,
  PorterRequest,
  QuotePorters,
  StorageType,
} from "./types";

// Pricing engine (docs/spec.md section 3, decisions D47–D58). Pure: no database, no Google Maps.
//
// Rounding (D56): every amount is integer cents. Each percentage is applied once per component with
// round-half-up (applyBp). VAT and carrier share: finalizeLines() (finalize.ts), shared with the
// porters-only and storage-only quotes (D151).

const HOUR_MS = 3_600_000;
const MAX_LEGS = 2; // D20: no intermediate stops; a warehouse order has two legs (D47)
const MAX_DISTANCE_M = 2_000_000;
const MAX_FLOOR = 20; // D53
const MAX_PORTERS = 4; // D54

const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;

const fail = (error: PricingError): PriceResult => ({ ok: false, error });
const invalid = (message: string): PriceResult => fail({ code: "invalid_input", message });

function validate(input: PriceInput): string | null {
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) return "now must be a valid date";
  if (!Array.isArray(input.legs) || input.legs.length < 1 || input.legs.length > MAX_LEGS) return `legs must have 1–${MAX_LEGS} items`;
  for (const [i, leg] of input.legs.entries()) {
    if (!isInt(leg.distanceM, 1, MAX_DISTANCE_M)) return `legs[${i}].distanceM must be 1–${MAX_DISTANCE_M}`;
    if (!(leg.pickupAt instanceof Date) || Number.isNaN(leg.pickupAt.getTime())) return `legs[${i}].pickupAt must be a valid date`;
    if (!isInt(leg.pickupFloor, 0, MAX_FLOOR) || !isInt(leg.deliveryFloor, 0, MAX_FLOOR)) return `legs[${i}] floors must be 0–${MAX_FLOOR}`;
    if (i > 0 && leg.pickupAt.getTime() < input.legs[i - 1].pickupAt.getTime()) return `legs[${i}] must not start before the previous leg`;
  }
  const legIndexOk = (idx: number | undefined) => idx === undefined || isInt(idx, 0, input.legs.length - 1);
  if (input.porters !== undefined) {
    if (!Array.isArray(input.porters)) return "porters must be an array";
    // Per leg: one package entry, or loading / unloading help (D182) with at most one entry per side — never both.
    const seen = new Set<string>();
    for (const [k, p] of input.porters.entries()) {
      if (!isInt(p.legIndex, 0, input.legs.length - 1)) return `porters[${k}].legIndex out of range`;
      if (isLoadingHelp(p)) {
        if (p.side !== "loading" && p.side !== "unloading") return `porters[${k}].side is unknown`;
        if (!isInt(p.persons, 1, MAX_PORTERS)) return `porters[${k}].persons must be 1–${MAX_PORTERS}`;
        if (!isInt(p.hours, 1, LOADING_HELP_MAX_HOURS)) return `porters[${k}].hours must be 1–${LOADING_HELP_MAX_HOURS}`;
        if (seen.has(`${p.legIndex}:both`) || seen.has(`${p.legIndex}:${p.side}`)) return `porters: more than one entry for leg ${p.legIndex}`;
        seen.add(`${p.legIndex}:${p.side}`);
      } else {
        if (!(PORTER_PACKAGE_CODES as readonly string[]).includes(p.packageCode)) return `porters[${k}].packageCode is unknown`;
        if (p.count !== undefined && !isInt(p.count, 1, MAX_PORTERS)) return `porters[${k}].count must be 1–${MAX_PORTERS}`;
        if ([...seen].some((s) => s.startsWith(`${p.legIndex}:`))) return `porters: more than one entry for leg ${p.legIndex}`;
        seen.add(`${p.legIndex}:both`);
      }
    }
  }
  if (input.packing) {
    if (!isInt(input.packing.itemsCount, 1, 500)) return "packing.itemsCount must be 1–500";
    if (!legIndexOk(input.packing.legIndex)) return "packing.legIndex out of range";
  }
  return null;
}

export function calculatePrice(input: PriceInput, config: PricingConfig): PriceResult {
  const validationError = validate(input);
  if (validationError) return invalid(validationError);

  const rules = enabledRules(config.rules);
  const amountOf = (code: PriceRuleCode) => rules.get(code)?.amountCents ?? null;

  const holidays = new Set(config.holidays);
  const area = new Set(config.serviceAreaProvinces.map((p) => p.toUpperCase()));
  const multiLeg = input.legs.length > 1;
  const legPrefix = (i: number) => (multiLeg ? `Tratta ${i + 1}: ` : "");

  // 1. Service area first (D13, D61): out-of-area requests get the contact form, not a price.
  for (const [i, leg] of input.legs.entries()) {
    const province = leg.pickupProvince.trim().toUpperCase();
    if (!area.has(province)) return fail({ code: "pickup_province", legIndex: i, province });
    if (leg.distanceM > config.maxRouteDistanceM) {
      return fail({ code: "max_distance", legIndex: i, distanceM: leg.distanceM, maxDistanceM: config.maxRouteDistanceM });
    }
  }

  const lines: DraftLine[] = [];
  const push = (line: Omit<DraftLine, "unitAmountCents"> & { unitAmountCents?: number | null }) =>
    lines.push({ unitAmountCents: null, ...line });
  const isUrgentByLeg: boolean[] = [];

  // 2. Transport legs with their surcharges (D47–D53). Surcharges belong to the transport group (D14).
  for (const [i, leg] of input.legs.entries()) {
    const leadMs = leg.pickupAt.getTime() - input.now.getTime();
    if (leadMs < config.minBookingLeadHours * HOUR_MS) return fail({ code: "too_soon", legIndex: i });

    const rate = config.vehicleRates.find((v) => v.vehicleTypeId === leg.vehicleTypeId);
    if (!rate) return fail({ code: "vehicle_not_priced", legIndex: i, vehicleTypeId: leg.vehicleTypeId });

    // D48: whole kilometres, rounded up; minimum price per leg.
    const km = Math.ceil(leg.distanceM / 1000);
    const byKm = km * rate.ratePerKmCents;
    const usesMinimum = byKm < rate.minPriceCents;
    const transportNet = usesMinimum ? rate.minPriceCents : byKm;
    push({
      lineType: "transport",
      labelIt: `${legPrefix(i)}Trasporto ${rate.nameIt}, ${km} km${usesMinimum ? " (prezzo minimo)" : ""}`,
      legIndex: i,
      quantity: usesMinimum ? 1 : km,
      unitAmountCents: usesMinimum ? rate.minPriceCents : rate.ratePerKmCents,
      netCents: transportNet,
      carrierShareGroup: "transport",
    });

    // D52: percentage surcharges use the transport amount after the minimum; urgent and weekend add up.
    const surcharge = (code: PriceRuleCode, lineType: OrderLineType, label: string) => {
      const rule = rules.get(code);
      if (!rule) return;
      const amount = rule.kind === "percent" ? applyBp(transportNet, rule.percentBp ?? 0) : (rule.amountCents ?? 0);
      if (amount > 0) {
        push({ lineType, labelIt: `${legPrefix(i)}${label}`, legIndex: i, quantity: 1, unitAmountCents: amount, netCents: amount, carrierShareGroup: "transport" });
      }
    };

    const urgent = leadMs < config.urgentLeadHours * HOUR_MS; // D49
    isUrgentByLeg.push(urgent);
    if (urgent) surcharge("surcharge_urgent", "surcharge_urgent", "Supplemento urgenza");
    if (isWeekendOrHoliday(leg.pickupAt, holidays)) {
      surcharge("surcharge_weekend_holiday", "surcharge_weekend_holiday", "Supplemento weekend/festivo"); // D51
    }

    // D53: each floor without an elevator, at pickup and at delivery.
    const floors = (leg.pickupHasElevator ? 0 : leg.pickupFloor) + (leg.deliveryHasElevator ? 0 : leg.deliveryFloor);
    const perFloor = amountOf("surcharge_floor_no_elevator");
    if (floors > 0 && perFloor !== null && perFloor > 0) {
      push({
        lineType: "surcharge_floors",
        labelIt: `${legPrefix(i)}Piani senza ascensore (${floors})`,
        legIndex: i,
        quantity: floors,
        unitAmountCents: perFloor,
        netCents: floors * perFloor,
        carrierShareGroup: "transport",
      });
    }
  }

  // 3. Porters per leg (D67, D74): package = persons × included hours × porter_hour. The customer may add
  //    persons (each gets the package's hours) but not hours; extra time is settled after the job (D68, D69).
  const porterTerms: Omit<QuotePorters, "carrierShare">[] = [];
  const sideOrder = { both: 0, loading: 1, unloading: 2 } as const;
  const sideOf = (r: PorterRequest) => (isLoadingHelp(r) ? r.side : "both");
  const requests = [...(input.porters ?? [])].sort((a, b) => a.legIndex - b.legIndex || sideOrder[sideOf(a)] - sideOrder[sideOf(b)]);
  for (const req of requests) {
    const perHour = amountOf("porter_hour");
    if (isLoadingHelp(req)) {
      // D182: loading / unloading help — persons × hours chosen by the customer × porter_hour, per side.
      if (perHour === null) return fail({ code: "service_unavailable", service: "porters" });
      const personHours = req.persons * req.hours;
      const who = `${req.persons} ${req.persons === 1 ? "persona" : "persone"} × ${req.hours} h`;
      push({
        lineType: "porters",
        labelIt: `${legPrefix(req.legIndex)}${req.side === "loading" ? "Aiuto al carico" : "Aiuto allo scarico"}: ${who}`,
        legIndex: req.legIndex,
        quantity: personHours,
        unitAmountCents: perHour,
        netCents: personHours * perHour,
        carrierShareGroup: "porters",
      });
      porterTerms.push({
        legIndex: req.legIndex,
        side: req.side,
        packageCode: null,
        persons: req.persons,
        includedHours: req.hours,
        overtimeRatePerPersonCents: amountOf("porter_overtime_hour"),
        overtimeGraceMinutes: config.porterOvertimeGraceMinutes,
      });
      continue;
    }
    const pkg = config.porterPackages.find((p) => p.code === req.packageCode);
    if (!pkg || !pkg.isEnabled || perHour === null) return fail({ code: "service_unavailable", service: "porters" });
    const count = req.count ?? pkg.portersCount;
    if (count < pkg.portersCount) return invalid(`porters.count must be at least ${pkg.portersCount} for ${pkg.code}`);
    const hours = pkg.includedHours;
    const personHours = count * hours;
    push({
      lineType: "porters",
      labelIt: `${legPrefix(req.legIndex)}Facchinaggio – ${PORTER_PACKAGE_LABEL[pkg.code]}: ${count} ${count === 1 ? "persona" : "persone"} × ${hours} h incluse`,
      legIndex: req.legIndex,
      quantity: personHours,
      unitAmountCents: perHour,
      netCents: personHours * perHour,
      carrierShareGroup: "porters",
    });
    porterTerms.push({
      legIndex: req.legIndex,
      side: "both",
      packageCode: pkg.code,
      persons: count,
      includedHours: hours,
      overtimeRatePerPersonCents: amountOf("porter_overtime_hour"),
      overtimeGraceMinutes: config.porterOvertimeGraceMinutes,
    });
  }

  // 4. Packing (D54): flat fee + per item, each can be disabled.
  if (input.packing) {
    const flat = amountOf("packing_flat");
    const perItem = amountOf("packing_per_item");
    if (flat === null && perItem === null) return fail({ code: "service_unavailable", service: "packing" });
    const legIndex = input.packing.legIndex ?? 0;
    if (flat !== null) {
      push({ lineType: "packing", labelIt: "Imballaggio (forfait)", legIndex, quantity: 1, unitAmountCents: flat, netCents: flat, carrierShareGroup: "packing" });
    }
    if (perItem !== null) {
      const n = input.packing.itemsCount;
      push({ lineType: "packing", labelIt: `Imballaggio: ${n} ${n === 1 ? "collo" : "colli"}`, legIndex, quantity: n, unitAmountCents: perItem, netCents: n * perItem, carrierShareGroup: "packing" });
    }
  }

  // 5. Storage (D55): 100 % Transigo.
  let storageType: StorageType | null = null;
  if (input.storage) {
    const perPallet = config.storageBillingUnit === "pallet_day";
    const result = storageCost({
      days: input.storage.days,
      pallets: input.storage.pallets,
      billingUnit: config.storageBillingUnit,
      shortTermMaxDays: config.storageShortTermMaxDays,
      rates: {
        transshipmentFlatCents: amountOf("transshipment_flat"),
        shortTermUnitCents: amountOf(perPallet ? "storage_pallet_day" : "storage_day"),
        longTermUnitCents: amountOf(perPallet ? "storage_pallet_day_long" : "storage_day_long"),
      },
    });
    if (!result.ok) {
      return result.reason === "rate_disabled"
        ? fail({ code: "service_unavailable", service: "storage" })
        : invalid(`storage: ${result.message}`);
    }
    storageType = result.storageType;
    const pallets = perPallet ? `, ${input.storage.pallets} pallet` : "";
    for (const s of result.segments) {
      const label =
        s.tier === "transshipment"
          ? "Trasbordo in magazzino"
          : `Deposito ${s.tier === "short_term" ? "breve" : "lungo"} periodo, giorni ${s.fromDay}–${s.toDay}${pallets}`;
      push({ lineType: "storage", labelIt: label, legIndex: null, quantity: s.quantity, unitAmountCents: s.unitAmountCents, netCents: s.amountCents, carrierShareGroup: "none" });
    }
  }

  // 6–7. VAT (D56) and carrier share per group (D57, D74).
  const { lines: quoteLines, subtotalCents, vatCents, warnings } = finalizeLines(lines, rules, config.vatRateBp);

  // Porter terms with the carrier share of the leg, so overtime gets the same share (D68, D74).
  const porters: QuotePorters[] = porterTerms.map((terms) => ({
    ...terms,
    carrierShare: porterShareTerms(rules, quoteLines.filter((l) => l.carrierShareGroup === "porters" && l.legIndex === terms.legIndex)),
  }));

  // Carrier amount per leg (each leg can be a separate job for a different carrier).
  const carrierAmountByLegCents = input.legs.map((_, i) =>
    quoteLines.filter((l) => l.legIndex === i).reduce((s, l) => s + l.carrierAmountCents, 0),
  );

  return {
    ok: true,
    quote: {
      priceListId: config.priceListId,
      priceListVersion: config.priceListVersion,
      customerType: input.customerType,
      display: input.customerType === "private" ? "gross" : "net_plus_vat",
      vatRateBp: config.vatRateBp,
      lines: quoteLines,
      subtotalCents,
      vatCents,
      totalCents: subtotalCents + vatCents,
      carrierAmountCents: carrierAmountByLegCents.reduce((s, a) => s + a, 0),
      carrierAmountByLegCents,
      storageType,
      porters,
      isUrgentByLeg,
      warnings,
    },
  };
}
