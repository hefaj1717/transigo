// "Impostazioni" (spec 9) — pure: the two forms (company data; rules) and the audit diff.
// The settings row is updated with the admin's session (RLS + column GRANTs); booking options (distance, lead time,
// quote validity, payment window) stay in "Area di servizio".
import { z } from "zod";
import { parsePercentToBp } from "@/lib/pricing/money";

/** Tag of the cached company data of the public pages (src/lib/public/server.ts) — refreshed after a save. */
export const COMPANY_INFO_CACHE_TAG = "company-info";

const optional = (max: number, re?: RegExp, message?: string) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || !re || re.test(v), { message: message ?? "Valore non valido." });

export const COMPANY_FIELDS = [
  "company_name", "company_vat_number", "company_fiscal_code", "company_street", "company_city", "company_postal_code",
  "company_province", "company_pec", "company_sdi_code", "company_email", "company_phone",
] as const;
export type CompanyField = (typeof COMPANY_FIELDS)[number];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const companySchema = z.object({
  company_name: optional(200),
  company_vat_number: optional(11, /^\d{11}$/, "La P.IVA ha 11 cifre."),
  company_fiscal_code: optional(16, /^(\d{11}|[A-Z0-9]{16})$/i, "Il codice fiscale ha 11 cifre o 16 caratteri."),
  company_street: optional(200),
  company_city: optional(100),
  company_postal_code: optional(5, /^\d{5}$/, "Il CAP ha 5 cifre."),
  company_province: optional(2, /^[A-Z]{2}$/i, "La provincia è una sigla di 2 lettere (es. MI)."),
  company_pec: optional(200, EMAIL, "PEC non valida."),
  company_sdi_code: optional(7, /^[A-Z0-9]{7}$/i, "Il codice SDI ha 7 caratteri."),
  company_email: optional(200, EMAIL, "E-mail non valida."),
  company_phone: optional(30, /^\+?[\d\s/.-]{6,}$/, "Telefono non valido."),
}).transform((v) => ({
  ...v,
  company_province: v.company_province?.toUpperCase() ?? null,
  company_fiscal_code: v.company_fiscal_code?.toUpperCase() ?? null,
  company_sdi_code: v.company_sdi_code?.toUpperCase() ?? null,
}));

/** Rules: hours as integers, the late-cancellation fee typed as a percentage → basis points (D137). */
export const rulesSchema = z.object({
  free_cancellation_hours: z.coerce.number().int().min(0).max(720),
  late_cancellation_fee_bp: z.string().transform((v, ctx) => {
    const bp = parsePercentToBp(v);
    if (bp === null || bp > 10_000) {
      ctx.addIssue({ code: "custom", message: "Penale: una percentuale da 0 a 100." });
      return z.NEVER;
    }
    return bp;
  }),
  payout_window_hours: z.coerce.number().int().min(0).max(720),
  unassigned_alert_hours: z.coerce.number().int().min(1).max(168),
});
export type Rules = z.output<typeof rulesSchema>;

export const RULES_ERROR = "Controlla i valori: ore 0–720 (avviso 1–168), penale 0–100 %.";

/** Only the fields whose value changes — for the update and the audit (Transigo's own data, no customers' data). */
export function changedFields<T extends Record<string, unknown>>(before: Partial<T> | null, after: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(after) as (keyof T)[]) if ((before?.[k] ?? null) !== (after[k] ?? null)) out[k] = after[k];
  return out;
}

/** 5000 bp → "50"; 1250 → "12,5". */
export const bpToPercentInput = (bp: number) => {
  const whole = Math.floor(bp / 100);
  const frac = String(bp % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole},${frac}` : String(whole);
};
