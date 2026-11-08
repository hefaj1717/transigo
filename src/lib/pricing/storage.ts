import type { StorageBillingUnit, StorageType } from "./types";

// Storage cost (D55). Pure function, also used in Stage 7 to price extensions of an existing storage.
//
//   days = 0 (and nothing paid before)  → transshipment flat fee
//   days 1 … shortTermMaxDays           → short-term rate
//   days above shortTermMaxDays         → long-term rate
//
// Tiers are progressive: a 45-day storage with a 30-day threshold is 30 days at the short rate plus
// 15 days at the long rate, so the cost never decreases when days are added.
// Per-unit amounts: billing "day" → days × rate; billing "pallet_day" → pallets × days × rate.

export type StorageRates = {
  transshipmentFlatCents: number | null; // null = service disabled
  shortTermUnitCents: number | null; // per day or per pallet-day (matching billingUnit)
  longTermUnitCents: number | null;
};

export type StorageCostInput = {
  days: number; // days to price (0 = transshipment)
  pallets?: number; // required for pallet_day
  /** Days already paid (Stage 7 extensions): prices days alreadyPaidDays+1 … alreadyPaidDays+days. */
  alreadyPaidDays?: number;
  billingUnit: StorageBillingUnit;
  shortTermMaxDays: number;
  rates: StorageRates;
};

export type StorageSegment = {
  tier: StorageType;
  fromDay: number | null; // 1-based, inclusive; null for transshipment
  toDay: number | null;
  days: number;
  quantity: number; // days or pallet-days (1 for transshipment)
  unitAmountCents: number;
  amountCents: number;
};

export type StorageCostResult =
  | { ok: true; storageType: StorageType; segments: StorageSegment[]; totalCents: number }
  | { ok: false; reason: "invalid_input" | "rate_disabled"; message: string };

const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;

export function storageCost(input: StorageCostInput): StorageCostResult {
  const { days, billingUnit, shortTermMaxDays, rates } = input;
  const alreadyPaid = input.alreadyPaidDays ?? 0;

  if (!isInt(days, 0, 3650)) return { ok: false, reason: "invalid_input", message: "days must be 0–3650" };
  if (!isInt(alreadyPaid, 0, 3650)) return { ok: false, reason: "invalid_input", message: "alreadyPaidDays must be 0–3650" };
  if (!isInt(shortTermMaxDays, 1, 3650)) return { ok: false, reason: "invalid_input", message: "shortTermMaxDays must be 1–3650" };

  // Transshipment: goods pass through the warehouse without being stored.
  if (days === 0) {
    if (alreadyPaid > 0) return { ok: false, reason: "invalid_input", message: "an extension needs at least 1 day" };
    if (rates.transshipmentFlatCents === null) return { ok: false, reason: "rate_disabled", message: "transshipment" };
    const amount = rates.transshipmentFlatCents;
    return {
      ok: true,
      storageType: "transshipment",
      segments: [{ tier: "transshipment", fromDay: null, toDay: null, days: 0, quantity: 1, unitAmountCents: amount, amountCents: amount }],
      totalCents: amount,
    };
  }

  let multiplier = 1;
  if (billingUnit === "pallet_day") {
    if (!isInt(input.pallets, 1, 10_000)) return { ok: false, reason: "invalid_input", message: "pallets must be 1–10000" };
    multiplier = input.pallets;
  }

  const firstDay = alreadyPaid + 1;
  const lastDay = alreadyPaid + days;
  const shortDays = Math.max(0, Math.min(lastDay, shortTermMaxDays) - firstDay + 1);
  const longDays = days - shortDays;

  const segments: StorageSegment[] = [];
  if (shortDays > 0) {
    if (rates.shortTermUnitCents === null) return { ok: false, reason: "rate_disabled", message: "short_term" };
    const quantity = shortDays * multiplier;
    segments.push({
      tier: "short_term",
      fromDay: firstDay,
      toDay: firstDay + shortDays - 1,
      days: shortDays,
      quantity,
      unitAmountCents: rates.shortTermUnitCents,
      amountCents: quantity * rates.shortTermUnitCents,
    });
  }
  if (longDays > 0) {
    if (rates.longTermUnitCents === null) return { ok: false, reason: "rate_disabled", message: "long_term" };
    const quantity = longDays * multiplier;
    const from = Math.max(firstDay, shortTermMaxDays + 1);
    segments.push({
      tier: "long_term",
      fromDay: from,
      toDay: lastDay,
      days: longDays,
      quantity,
      unitAmountCents: rates.longTermUnitCents,
      amountCents: quantity * rates.longTermUnitCents,
    });
  }

  return {
    ok: true,
    // Type of the whole storage period (including days already paid).
    storageType: lastDay > shortTermMaxDays ? "long_term" : "short_term",
    segments,
    totalCents: segments.reduce((s, x) => s + x.amountCents, 0),
  };
}
