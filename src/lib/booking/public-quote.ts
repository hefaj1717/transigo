// What the browser may see of a quote (D29, D76): customer amounts only — no carrier amounts, carrier
// shares, margin or admin warnings. Every quote leaves the server through toPublicQuote().
import { applyBp } from "../pricing/money";
import type { OrderLineType, PorterPackageCode, Quote, StorageType } from "../pricing/types";

export type PublicQuoteLine = {
  lineType: OrderLineType;
  labelIt: string;
  legIndex: number | null;
  quantity: number;
  unitAmountCents: number | null;
  netCents: number;
  vatCents: number;
  grossCents: number;
};

export type PublicPorterTerms = {
  legIndex: number;
  packageCode: PorterPackageCode;
  persons: number;
  includedHours: number;
  /** Per person, per started hour (D68); null = overtime not charged. Net and with VAT for display (D3). */
  overtimeRateNetCents: number | null;
  overtimeRateGrossCents: number | null;
  overtimeGraceMinutes: number;
};

export type PublicQuote = {
  customerType: "private" | "business";
  display: "gross" | "net_plus_vat";
  vatRateBp: number;
  lines: PublicQuoteLine[];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  storageType: StorageType | null;
  porters: PublicPorterTerms[];
  isUrgentByLeg: boolean[];
};

export function toPublicQuote(q: Quote): PublicQuote {
  return {
    customerType: q.customerType,
    display: q.display,
    vatRateBp: q.vatRateBp,
    lines: q.lines.map((l) => ({
      lineType: l.lineType,
      labelIt: l.labelIt,
      legIndex: l.legIndex,
      quantity: l.quantity,
      unitAmountCents: l.unitAmountCents,
      netCents: l.netCents,
      vatCents: l.vatCents,
      grossCents: l.grossCents,
    })),
    subtotalCents: q.subtotalCents,
    vatCents: q.vatCents,
    totalCents: q.totalCents,
    storageType: q.storageType,
    porters: q.porters.map((p) => ({
      legIndex: p.legIndex,
      packageCode: p.packageCode,
      persons: p.persons,
      includedHours: p.includedHours,
      overtimeRateNetCents: p.overtimeRatePerPersonCents,
      // Display only; the overtime invoice (Stage 6) computes VAT on its own total (D56).
      overtimeRateGrossCents: p.overtimeRatePerPersonCents === null ? null : p.overtimeRatePerPersonCents + applyBp(p.overtimeRatePerPersonCents, q.vatRateBp),
      overtimeGraceMinutes: p.overtimeGraceMinutes,
    })),
    isUrgentByLeg: q.isUrgentByLeg,
  };
}

/** The amount shown as "the price": gross for private customers, net (+ IVA) for businesses (D3). */
export function headlineCents(q: Pick<PublicQuote, "display" | "totalCents" | "subtotalCents">): number {
  return q.display === "gross" ? q.totalCents : q.subtotalCents;
}
