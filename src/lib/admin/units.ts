// Unit helpers for admin forms. Volumes are stored as integer dm³ (D81) and typed by the admin in m³.

/** "9" / "9,5" / "19.250" (m³, max 3 decimals) → dm³ as an integer, without floating point. null = invalid. */
export function parseCubicMetresToDm3(input: string): number | null {
  const m = /^(\d{1,4})(?:[.,](\d{1,3}))?$/.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
}

/** 9500 → "9,5"; 20000 → "20"; 1200 → "1,2". */
export function formatDm3AsCubicMetres(dm3: number): string {
  const whole = Math.floor(dm3 / 1000);
  const frac = String(dm3 % 1000).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole},${frac}` : String(whole);
}
