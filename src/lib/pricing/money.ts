// Integer money helpers. All amounts are EUR cents (integers); percentages are basis points
// (1 bp = 0.01 %, 22 % = 2200). Intermediate products use BigInt so nothing ever goes through floats.

const BP_DENOMINATOR = 10_000n;

function assertNonNegativeInt(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${value}`);
  }
}

/**
 * round_half_up(a × numerator / denominator) for non-negative integers.
 * "Half up" = commercial rounding: exactly half a cent goes up (269.5 → 270, 271.48 → 271).
 */
export function mulDivRoundHalfUp(a: number, numerator: number, denominator: number): number {
  assertNonNegativeInt(a, "a");
  assertNonNegativeInt(numerator, "numerator");
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new RangeError("denominator must be > 0");
  const n = BigInt(a) * BigInt(numerator);
  const d = BigInt(denominator);
  return Number((n * 2n + d) / (d * 2n));
}

/** round_half_up(amount × bp / 10000) — percentage of an amount in cents (D56). */
export function applyBp(amountCents: number, bp: number): number {
  return mulDivRoundHalfUp(amountCents, bp, Number(BP_DENOMINATOR));
}

/**
 * Splits `total` cents into integer parts proportional to `weights` (largest remainder method).
 * The parts always sum to exactly `total`. Ties go to the earlier index. If all weights are 0,
 * everything goes to the first part. Used for VAT per line and carrier share per line (D56, D57).
 */
export function allocateProportionally(total: number, weights: number[]): number[] {
  assertNonNegativeInt(total, "total");
  if (weights.length === 0) {
    if (total !== 0) throw new RangeError("cannot allocate a non-zero total to no parts");
    return [];
  }
  weights.forEach((w, i) => assertNonNegativeInt(w, `weights[${i}]`));
  const sum = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (sum === 0n) return weights.map((_, i) => (i === 0 ? total : 0));

  const T = BigInt(total);
  const parts = weights.map((w) => (T * BigInt(w)) / sum);
  const remainders = weights.map((w, i) => ({ i, r: (T * BigInt(w)) % sum }));
  let left = Number(T - parts.reduce((s, p) => s + p, 0n));
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (let k = 0; left > 0; k++, left--) parts[remainders[k].i] += 1n;
  return parts.map(Number);
}

/**
 * Parses a euro amount typed by a user ("1,20", "1.234,50", "15", "0.9") into cents without floats.
 * Accepts at most 2 decimals; returns null for anything else.
 */
export function parseEuroToCents(input: string): number | null {
  let s = input.trim().replace(/\s|€/g, "");
  if (s === "") return null;
  // Italian format: dots as thousands separators, comma as decimal separator.
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Parses a percentage ("70", "12,5", "0.25") into basis points without floats; at most 2 decimals. */
export function parsePercentToBp(input: string): number | null {
  const s = input.trim().replace(/\s|%/g, "").replace(",", ".");
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Formats cents as an Italian euro string, e.g. 123456 → "1.234,56 €". Display only. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${euros},${String(abs % 100).padStart(2, "0")} €`;
}

/** Formats basis points as a percentage string, e.g. 2200 → "22", 1250 → "12,5". */
export function formatBp(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac === 0 ? String(whole) : `${whole},${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}
