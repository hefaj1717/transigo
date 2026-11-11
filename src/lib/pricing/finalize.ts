import { allocateProportionally, applyBp } from "./money";
import type { CarrierShareGroup, PriceRule, PriceRuleCode, QuoteLine, QuoteWarning } from "./types";

// Shared last step of every quote (transport, porters, storage): VAT and carrier share.
//
// VAT (D56): once on the subtotal with round-half-up, split over the lines proportionally to their net
// amount (largest remainder), so line VATs always add up to the total.
// Carrier share (D57, D74): once per group on the net amount — transport and porters per leg, packing
// per order — split over the group's lines the same way. Storage ("none") is 100 % Transigo.

export type DraftLine = Omit<QuoteLine, "vatCents" | "grossCents" | "carrierAmountCents">;

export type FinalizedLines = {
  lines: QuoteLine[];
  subtotalCents: number;
  vatCents: number;
  warnings: QuoteWarning[];
};

const SHARE_RULE: Record<Exclude<CarrierShareGroup, "none">, PriceRuleCode> = {
  transport: "carrier_share_transport",
  porters: "carrier_share_porters",
  packing: "carrier_share_packing",
};

/** `rules` = enabled rules of the price list by code. */
export function finalizeLines(lines: DraftLine[], rules: Map<PriceRuleCode, PriceRule>, vatRateBp: number): FinalizedLines {
  const nets = lines.map((l) => l.netCents);
  const subtotalCents = nets.reduce((s, n) => s + n, 0);
  const vatCents = applyBp(subtotalCents, vatRateBp);
  const lineVat = allocateProportionally(vatCents, nets);

  const carrierAmounts = lines.map(() => 0);
  const warnings: QuoteWarning[] = [];
  const buckets = new Map<string, number[]>(); // key → line indexes
  lines.forEach((l, idx) => {
    if (l.carrierShareGroup === "none") return;
    const key = l.carrierShareGroup === "packing" ? "packing" : `${l.carrierShareGroup}:${l.legIndex}`;
    buckets.set(key, [...(buckets.get(key) ?? []), idx]);
  });
  for (const idxs of buckets.values()) {
    const group = lines[idxs[0]].carrierShareGroup as Exclude<CarrierShareGroup, "none">;
    const base = idxs.reduce((s, i) => s + lines[i].netCents, 0);
    const rule = rules.get(SHARE_RULE[group]);
    // A disabled carrier-share rule means the carrier gets nothing for that group.
    const share = !rule ? 0 : rule.kind === "percent" ? applyBp(base, rule.percentBp ?? 0) : (rule.amountCents ?? 0);
    if (share > base) warnings.push({ code: "negative_margin", group, legIndex: group === "packing" ? null : lines[idxs[0]].legIndex });
    allocateProportionally(share, idxs.map((i) => lines[i].netCents)).forEach((a, k) => (carrierAmounts[idxs[k]] = a));
  }

  return {
    lines: lines.map((l, idx) => ({ ...l, vatCents: lineVat[idx], grossCents: l.netCents + lineVat[idx], carrierAmountCents: carrierAmounts[idx] })),
    subtotalCents,
    vatCents,
    warnings,
  };
}

/** Enabled rules by code. */
export function enabledRules(rules: PriceRule[]): Map<PriceRuleCode, PriceRule> {
  const map = new Map<PriceRuleCode, PriceRule>();
  for (const r of rules) if (r.isEnabled) map.set(r.code, r);
  return map;
}

/** Carrier share terms for porter overtime (D68): percent, or the bought proportion for a fixed rule. */
export function porterShareTerms(
  rules: Map<PriceRuleCode, PriceRule>,
  porterLines: QuoteLine[],
): { kind: "percent"; percentBp: number } | { kind: "ratio"; carrierCents: number; netCents: number } | null {
  const rule = rules.get("carrier_share_porters");
  if (!rule) return null;
  if (rule.kind === "percent") return { kind: "percent", percentBp: rule.percentBp ?? 0 };
  // A fixed amount per leg cannot be applied per hour: overtime keeps the package's proportion.
  return {
    kind: "ratio",
    carrierCents: porterLines.reduce((s, l) => s + l.carrierAmountCents, 0),
    netCents: porterLines.reduce((s, l) => s + l.netCents, 0),
  };
}
