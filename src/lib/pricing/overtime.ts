import { applyBp, mulDivRoundHalfUp } from "./money";
import type { QuotePorters } from "./types";

// Porter overtime after the job (D68, D69). Pure; used in Stages 4/6 with the porter terms stored
// with the order (Quote.porters[], per leg — D74), never with the current price list.
//
// Working time = loading + unloading only (arrival at pickup → loaded, arrival at delivery → unloaded),
// NOT the driving time. The caller passes the sum of those two segments in minutes.
//
// Rule: nothing is charged while worked ≤ included time + grace. Above that, every started hour over
// the included time (not over the grace) is charged per person: ceil((worked − included) / 60).
// Shorter work is never refunded.

export type PorterOvertimeInput = {
  workedMinutes: number; // loading + unloading
  terms: Pick<QuotePorters, "persons" | "includedHours" | "overtimeRatePerPersonCents" | "overtimeGraceMinutes" | "carrierShare">;
  vatRateBp: number;
};

export type PorterOvertimeResult =
  | {
      ok: true;
      overtimeHours: number; // started hours charged per person (0 = nothing to pay)
      personHours: number;
      netCents: number;
      vatCents: number; // round half up on the net (D56)
      grossCents: number;
      carrierAmountCents: number; // same share as the porters group (D57), round half up
    }
  | { ok: false; message: string };

const MAX_WORKED_MINUTES = 24 * 60;

export function porterOvertimeCost({ workedMinutes, terms, vatRateBp }: PorterOvertimeInput): PorterOvertimeResult {
  if (!Number.isSafeInteger(workedMinutes) || workedMinutes < 0 || workedMinutes > MAX_WORKED_MINUTES) {
    return { ok: false, message: `workedMinutes must be an integer 0–${MAX_WORKED_MINUTES}` };
  }
  const { persons, includedHours, overtimeRatePerPersonCents: rate, overtimeGraceMinutes: grace } = terms;
  if (!Number.isSafeInteger(persons) || persons < 1 || !Number.isSafeInteger(includedHours) || includedHours < 1) {
    return { ok: false, message: "invalid porter terms" };
  }
  if (!Number.isSafeInteger(grace) || grace < 0) return { ok: false, message: "invalid grace minutes" };

  const includedMinutes = includedHours * 60;
  const over = workedMinutes - includedMinutes;
  // Overtime disabled in the bought price list, or within included time + grace: nothing to pay.
  const overtimeHours = rate === null || workedMinutes <= includedMinutes + grace ? 0 : Math.ceil(over / 60);

  const personHours = overtimeHours * persons;
  const netCents = personHours * (rate ?? 0);
  const vatCents = applyBp(netCents, vatRateBp);
  const share = terms.carrierShare;
  const carrierAmountCents =
    !share || netCents === 0
      ? 0
      : share.kind === "percent"
        ? applyBp(netCents, share.percentBp)
        : share.netCents === 0
          ? 0
          : mulDivRoundHalfUp(netCents, share.carrierCents, share.netCents);

  return { ok: true, overtimeHours, personHours, netCents, vatCents, grossCents: netCents + vatCents, carrierAmountCents };
}
