// zod schemas for account forms. Used by Server Actions (server-side validation is authoritative).
// Field names match the form input `name` attributes. Messages are Italian (UI language).
// Decisions: D42 (consents), D43 (private customer), D44 (business customer), D45 (carrier).
import { z } from "zod";
import { it as italianLocale } from "zod/locales";
import {
  compactUpper,
  isValidBusinessFiscalCode,
  isValidCap,
  isValidPartitaIva,
  isValidProvince,
  isValidSdiCode,
  normalizePartitaIva,
  normalizePhone,
  SDI_NO_CHANNEL,
} from "./italian-ids";

z.config(italianLocale()); // fallback messages for anything not customised below

export const MSG = {
  required: "Campo obbligatorio",
  email: "Inserisci un indirizzo e-mail valido",
  passwordLength: "La password deve avere almeno 8 caratteri",
  passwordTooLong: "La password può avere al massimo 72 caratteri",
  passwordStrength: "La password deve contenere almeno una lettera e un numero",
  passwordMismatch: "Le password non coincidono",
  phone: "Inserisci un numero di telefono valido (es. 333 123 4567)",
  vat: "Partita IVA non valida",
  fiscalCode: "Codice fiscale non valido",
  sdi: "Il codice destinatario SDI ha 7 caratteri (lettere e numeri)",
  pec: "Inserisci un indirizzo PEC valido",
  einvoiceChannel: "Indica il codice destinatario SDI oppure la PEC",
  pecRequiredWithZeroSdi: "Con codice destinatario 0000000 è necessaria la PEC",
  cap: "Il CAP ha 5 cifre",
  province: "Sigla della provincia non valida (es. MI)",
  terms: "Devi accettare i Termini e condizioni",
  privacy: "Devi accettare l'Informativa sulla privacy",
  customerType: "Scegli Privato o Azienda",
  tooLong: "Testo troppo lungo",
} as const;

// ---------------------------------------------------------------------------
// Field building blocks
// ---------------------------------------------------------------------------

const requiredText = (max = 120) =>
  z.string({ error: MSG.required }).trim().min(1, { error: MSG.required }).max(max, { error: MSG.tooLong });

const email = z
  .string({ error: MSG.required })
  .trim()
  .toLowerCase()
  .min(1, { error: MSG.required })
  .pipe(z.email({ error: MSG.email }).max(254, { error: MSG.email }));

// 72 = bcrypt input limit used by Supabase Auth. Keep in sync with Auth → Password requirements (min 8).
export const password = z
  .string({ error: MSG.required })
  .min(8, { error: MSG.passwordLength })
  .max(72, { error: MSG.passwordTooLong })
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), { error: MSG.passwordStrength });

const requiredPhone = z
  .string({ error: MSG.required })
  .trim()
  .min(1, { error: MSG.required })
  .transform((v, ctx) => {
    const e164 = normalizePhone(v);
    if (!e164) ctx.addIssue({ code: "custom", message: MSG.phone });
    return e164 ?? v;
  });

export const optionalPhone = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v?.trim()) return undefined;
    const e164 = normalizePhone(v);
    if (!e164) ctx.addIssue({ code: "custom", message: MSG.phone });
    return e164 ?? v;
  });

const vatNumber = z
  .string({ error: MSG.required })
  .transform(normalizePartitaIva)
  .pipe(z.string().min(1, { error: MSG.required }).refine(isValidPartitaIva, { error: MSG.vat }));

const businessFiscalCode = z
  .string({ error: MSG.required })
  .transform(compactUpper)
  .pipe(z.string().min(1, { error: MSG.required }).refine(isValidBusinessFiscalCode, { error: MSG.fiscalCode }));

const optionalSdi = z
  .string()
  .optional()
  .transform((v) => (v ? compactUpper(v) : "") || undefined)
  .pipe(z.string().refine(isValidSdiCode, { error: MSG.sdi }).optional());

const optionalPec = z
  .string()
  .optional()
  .transform((v) => v?.trim().toLowerCase() || undefined)
  .pipe(z.email({ error: MSG.pec }).max(254, { error: MSG.pec }).optional());

/** HTML checkbox: present with value "on" when ticked. */
const checkbox = (message: string) =>
  z
    .string()
    .optional()
    .refine((v) => v === "on", { error: message })
    .transform(() => true as const);

// ---------------------------------------------------------------------------
// Shared refinements
// ---------------------------------------------------------------------------

type WithPasswords = { password: string; passwordConfirm: string };
const passwordsMatch = (d: WithPasswords) => d.password === d.passwordConfirm;
const passwordsMatchParams = { error: MSG.passwordMismatch, path: ["passwordConfirm"] };

type WithEinvoice = { sdiCode?: string; pec?: string };
/** D44/D45: SDI or PEC required; "0000000" means "use PEC", so it needs a PEC too. */
function checkEinvoiceChannel(d: WithEinvoice, ctx: z.RefinementCtx) {
  if (d.pec) return;
  if (!d.sdiCode) {
    ctx.addIssue({ code: "custom", message: MSG.einvoiceChannel, path: ["sdiCode"] });
  } else if (d.sdiCode === SDI_NO_CHANNEL) {
    ctx.addIssue({ code: "custom", message: MSG.pecRequiredWithZeroSdi, path: ["pec"] });
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const accountFields = {
  firstName: requiredText(80),
  lastName: requiredText(80),
  email,
  password,
  passwordConfirm: z.string({ error: MSG.required }),
  acceptTerms: checkbox(MSG.terms),
  acceptPrivacy: checkbox(MSG.privacy),
};

/** D43: private customer — no codice fiscale / billing address at sign-up (collected in "Riepilogo"). */
export const privateCustomerSchema = z
  .object({
    customerType: z.literal("private"),
    ...accountFields,
    phone: optionalPhone,
  })
  .refine(passwordsMatch, passwordsMatchParams);

/** D44: business customer — company name, P.IVA, SDI or PEC. */
export const businessCustomerSchema = z
  .object({
    customerType: z.literal("business"),
    ...accountFields,
    phone: optionalPhone,
    companyName: requiredText(160),
    vatNumber,
    sdiCode: optionalSdi,
    pec: optionalPec,
  })
  .refine(passwordsMatch, passwordsMatchParams)
  .superRefine(checkEinvoiceChannel);

export const customerRegistrationSchema = z.discriminatedUnion(
  "customerType",
  [privateCustomerSchema, businessCustomerSchema],
  { error: MSG.customerType },
);
export type CustomerRegistration = z.output<typeof customerRegistrationSchema>;

/** D45: company fields of a carrier (registration and onboarding "Dati aziendali"). */
const carrierCompanyFields = {
  companyName: requiredText(160),
  vatNumber,
  fiscalCode: businessFiscalCode,
  hqStreet: requiredText(160),
  hqCity: requiredText(80),
  hqPostalCode: z
    .string({ error: MSG.required })
    .trim()
    .min(1, { error: MSG.required })
    .refine(isValidCap, { error: MSG.cap }),
  hqProvince: z
    .string({ error: MSG.required })
    .transform(compactUpper)
    .pipe(z.string().min(1, { error: MSG.required }).refine(isValidProvince, { error: MSG.province })),
  sdiCode: optionalSdi,
  pec: optionalPec,
};

/** D45: carrier — personal data, phone (verified by SMS in Stage 4), company data, HQ address, SDI or PEC. */
export const carrierRegistrationSchema = z
  .object({
    ...accountFields,
    phone: requiredPhone,
    ...carrierCompanyFields,
  })
  .refine(passwordsMatch, passwordsMatchParams)
  .superRefine(checkEinvoiceChannel);
export type CarrierRegistration = z.output<typeof carrierRegistrationSchema>;

/** Carrier onboarding "Dati aziendali" (D105: editable only until the account is sent for review). */
export const carrierCompanySchema = z.object(carrierCompanyFields).superRefine(checkEinvoiceChannel);
export type CarrierCompany = z.output<typeof carrierCompanySchema>;

/** Form values → carriers columns. Empty SDI / PEC become null (the other channel is used). */
export function carrierCompanyRow(c: CarrierCompany) {
  return {
    company_name: c.companyName,
    vat_number: c.vatNumber,
    fiscal_code: c.fiscalCode,
    hq_street: c.hqStreet,
    hq_city: c.hqCity,
    hq_postal_code: c.hqPostalCode,
    hq_province: c.hqProvince,
    sdi_code: c.sdiCode ?? null,
    pec: c.pec ?? null,
  };
}

// ---------------------------------------------------------------------------
// Sign-in and password reset
// ---------------------------------------------------------------------------

export const signInSchema = z.object({
  email,
  password: z.string({ error: MSG.required }).min(1, { error: MSG.required }),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z
  .object({ password, passwordConfirm: z.string({ error: MSG.required }) })
  .refine(passwordsMatch, passwordsMatchParams);

// ---------------------------------------------------------------------------
// Helpers for Server Actions
// ---------------------------------------------------------------------------

/** FormData → plain object of strings (files are ignored; repeated keys keep the last value). */
export function formDataToObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export type FieldErrors = Record<string, string>;

/** First message per field; errors without a field go under "_form". */
export function toFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? String(issue.path[0]) : "_form";
    out[key] ??= issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Customer profile completion (D80) — accounts created without the sign-up form (e.g. Supabase dashboard)
// ---------------------------------------------------------------------------

const profileFields = {
  firstName: requiredText(80),
  lastName: requiredText(80),
  phone: optionalPhone,
  acceptTerms: checkbox(MSG.terms),
  acceptPrivacy: checkbox(MSG.privacy),
};

/** The customers row already exists (type cannot change): only name, phone and consents. */
export const existingCustomerProfileSchema = z.object(profileFields);

/** No customers row yet: choose Privato / Azienda like at sign-up (D43, D44). */
export const customerProfileCompletionSchema = z.discriminatedUnion(
  "customerType",
  [
    z.object({ customerType: z.literal("private"), ...profileFields }),
    z
      .object({
        customerType: z.literal("business"),
        ...profileFields,
        companyName: requiredText(160),
        vatNumber,
        sdiCode: optionalSdi,
        pec: optionalPec,
      })
      .superRefine(checkEinvoiceChannel),
  ],
  { error: MSG.customerType },
);
