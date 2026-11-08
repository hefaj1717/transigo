// Validators and normalizers for Italian identifiers used in registration forms.
// Pure functions (no I/O) so they can be shared by zod schemas and unit tests.

/** Uppercases and removes all whitespace. */
export function compactUpper(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

// ---------------------------------------------------------------------------
// Codice fiscale (persona fisica, 16 characters, with check character)
// ---------------------------------------------------------------------------

// Positions 7-8, 10-11, 13-15 are digits, but may be replaced by letters (omocodia): 0-9 → L M N P Q R S T U V.
const CF_PATTERN = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

// Values of characters in odd positions (1st, 3rd, ...) per the official algorithm (DM 23/12/1976).
const CF_ODD: Record<string, number> = {
  "0": 1, "1": 0, "2": 5, "3": 7, "4": 9, "5": 13, "6": 15, "7": 17, "8": 19, "9": 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};

/** Value of a character in an even position: digits 0-9 → 0-9, letters A-Z → 0-25. */
function cfEvenValue(ch: string): number {
  return /[0-9]/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 65;
}

/** Computes the check character for the first 15 characters of a codice fiscale. */
export function codiceFiscaleCheckChar(first15: string): string {
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = first15[i];
    sum += i % 2 === 0 ? CF_ODD[ch] : cfEvenValue(ch); // i = 0 is position 1 (odd)
  }
  return String.fromCharCode(65 + (sum % 26));
}

/** Personal codice fiscale (16 characters). Expects a compacted, uppercase value. */
export function isValidCodiceFiscale(value: string): boolean {
  if (!CF_PATTERN.test(value)) return false;
  return codiceFiscaleCheckChar(value.slice(0, 15)) === value[15];
}

// ---------------------------------------------------------------------------
// Partita IVA (11 digits, Luhn-like check digit)
// ---------------------------------------------------------------------------

/** Removes whitespace and an optional "IT" prefix. */
export function normalizePartitaIva(value: string): string {
  return compactUpper(value).replace(/^IT/, "");
}

/** Partita IVA (11 digits). Expects a normalized value (see normalizePartitaIva). */
export function isValidPartitaIva(value: string): boolean {
  if (!/^\d{11}$/.test(value) || value === "00000000000") return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let d = Number(value[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(value[10]);
}

/**
 * Codice fiscale of a company or sole trader: either a personal CF (16 chars)
 * or a numeric company CF (11 digits, same algorithm as the Partita IVA).
 */
export function isValidBusinessFiscalCode(value: string): boolean {
  return value.length === 11 ? isValidPartitaIva(value) : isValidCodiceFiscale(value);
}

// ---------------------------------------------------------------------------
// Codice destinatario SDI
// ---------------------------------------------------------------------------

/** "0000000" means "no SDI channel, use PEC" — it does not count as an e-invoicing channel. */
export const SDI_NO_CHANNEL = "0000000";

/** Codice destinatario: 7 alphanumeric characters. Expects a compacted, uppercase value. */
export function isValidSdiCode(value: string): boolean {
  return /^[A-Z0-9]{7}$/.test(value);
}

// ---------------------------------------------------------------------------
// Address parts
// ---------------------------------------------------------------------------

export function isValidCap(value: string): boolean {
  return /^\d{5}$/.test(value);
}

/** Province abbreviations (sigle automobilistiche) in use. */
export const PROVINCES = new Set([
  "AG", "AL", "AN", "AO", "AP", "AQ", "AR", "AT", "AV", "BA", "BG", "BI", "BL", "BN", "BO", "BR", "BS", "BT",
  "BZ", "CA", "CB", "CE", "CH", "CL", "CN", "CO", "CR", "CS", "CT", "CZ", "EN", "FC", "FE", "FG", "FI", "FM",
  "FR", "GE", "GO", "GR", "IM", "IS", "KR", "LC", "LE", "LI", "LO", "LT", "LU", "MB", "MC", "ME", "MI", "MN",
  "MO", "MS", "MT", "NA", "NO", "NU", "OR", "PA", "PC", "PD", "PE", "PG", "PI", "PN", "PO", "PR", "PT", "PU",
  "PV", "PZ", "RA", "RC", "RE", "RG", "RI", "RM", "RN", "RO", "SA", "SI", "SO", "SP", "SR", "SS", "SU", "SV",
  "TA", "TE", "TN", "TO", "TP", "TR", "TS", "TV", "UD", "VA", "VB", "VC", "VE", "VI", "VR", "VT", "VV",
]);

export function isValidProvince(value: string): boolean {
  return PROVINCES.has(value);
}

// ---------------------------------------------------------------------------
// Phone numbers → E.164
// ---------------------------------------------------------------------------

/**
 * Normalizes a phone number to E.164. Numbers without a country prefix are treated as Italian
 * (mobile "3…" or landline "0…") and get +39. Returns null when the result is not a plausible E.164 number.
 */
export function normalizePhone(value: string): string | null {
  let v = value.replace(/[\s\-./()]/g, "");
  if (v.startsWith("00")) v = `+${v.slice(2)}`;
  if (!v.startsWith("+")) {
    if (!/^[03]\d+$/.test(v)) return null;
    v = `+39${v}`;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(v)) return null;
  // Italian numbers: mobile +39 3xx (9-10 digits) or landline +39 0x (6-11 digits).
  if (v.startsWith("+39") && !/^\+39(3\d{8,9}|0\d{5,10})$/.test(v)) return null;
  return v;
}
