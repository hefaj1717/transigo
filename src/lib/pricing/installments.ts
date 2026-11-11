import { applyBp } from "./money";
import { STORAGE_MONTH_DAYS } from "./storage-service";

// Monthly installments for long storage (D155). Pure.
//
// Offered only for periods longer than 2 months (> 60 days). One installment per started 30-day month;
// the first is paid at booking, installment k (k ≥ 1) is due on start date + 30 × k days, so each
// installment is paid before the month it covers.
//
// Every installment gets its own invoice, so its VAT is computed on its own net amount (round half up,
// D56) — not split from the quote's VAT. The net is split evenly in cents; the remainder goes to the
// first installment. Because VAT is rounded per invoice, the plan total may differ from the one-off
// total by at most 1 cent per installment (shown to the customer as the plan total).

export const MONTHLY_PLAN_MIN_DAYS = 2 * STORAGE_MONTH_DAYS + 1;

export type Installment = {
  index: number; // 0 = at booking
  dueDate: string | null; // "YYYY-MM-DD" (Europe/Rome calendar date); null = at booking
  netCents: number;
  vatCents: number;
  grossCents: number;
};

export type InstallmentPlan =
  | { ok: true; installments: Installment[]; totalCents: number }
  | { ok: false; reason: "too_short" | "invalid_input" };

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function installmentPlan(input: { netCents: number; vatRateBp: number; days: number; startDate: string }): InstallmentPlan {
  const { netCents, vatRateBp, days, startDate } = input;
  if (!Number.isSafeInteger(netCents) || netCents <= 0) return { ok: false, reason: "invalid_input" };
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) return { ok: false, reason: "invalid_input" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || addDays(startDate, 0) !== startDate) return { ok: false, reason: "invalid_input" };
  if (days < MONTHLY_PLAN_MIN_DAYS) return { ok: false, reason: "too_short" };

  const count = Math.ceil(days / STORAGE_MONTH_DAYS);
  const base = Math.floor(netCents / count);
  const installments: Installment[] = Array.from({ length: count }, (_, k) => {
    const net = k === 0 ? netCents - base * (count - 1) : base;
    const vat = applyBp(net, vatRateBp);
    return { index: k, dueDate: k === 0 ? null : addDays(startDate, STORAGE_MONTH_DAYS * k), netCents: net, vatCents: vat, grossCents: net + vat };
  });
  return { ok: true, installments, totalCents: installments.reduce((s, i) => s + i.grossCents, 0) };
}
