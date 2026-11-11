// "Profilo" of the customer area (spec 7): personal data, default billing data (D36) and password change.
// Pure: schemas and form ↔ row mapping. The billing rules are the same as in "Riepilogo" (D43, D44), so data
// saved here passes the checkout as it is. Writes happen with the customer's own session (RLS + column grants).
import { z } from "zod";
import { MSG, optionalPhone, password } from "@/lib/auth/schemas";
import { businessBillingSchema, privateBillingSchema } from "@/lib/booking/checkout";

export type CustomerType = "private" | "business";

const name = z.string({ error: MSG.required }).trim().min(1, { error: MSG.required }).max(80, { error: MSG.tooLong });

export const personalDataSchema = z.object({ firstName: name, lastName: name, phone: optionalPhone });
export type PersonalData = z.output<typeof personalDataSchema>;

/** profiles columns the customer may update (grant: first_name, last_name, phone). */
export function personalDataRow(d: PersonalData) {
  return { first_name: d.firstName, last_name: d.lastName, phone: d.phone ?? null };
}

export function billingSchemaFor(type: CustomerType) {
  return type === "private" ? privateBillingSchema : businessBillingSchema;
}

type PrivateBilling = z.output<typeof privateBillingSchema>;
type BusinessBilling = z.output<typeof businessBillingSchema>;

/**
 * customers columns for the default billing data. The customer type never changes (server-protected column);
 * a private customer never writes company fields, a business customer never writes a codice fiscale.
 */
export function billingRow(type: CustomerType, d: PrivateBilling | BusinessBilling) {
  const address = { billing_street: d.street, billing_city: d.city, billing_postal_code: d.postalCode, billing_province: d.province, billing_country: "IT" };
  if (type === "private" && "fiscalCode" in d) return { fiscal_code: d.fiscalCode, ...address };
  if (type === "business" && "companyName" in d) {
    return { company_name: d.companyName, vat_number: d.vatNumber, sdi_code: d.sdiCode ?? null, pec: d.pec ?? null, ...address };
  }
  throw new Error("billing data does not match the customer type");
}

export type CustomerRow = {
  customer_type: CustomerType;
  company_name: string | null;
  vat_number: string | null;
  fiscal_code: string | null;
  sdi_code: string | null;
  pec: string | null;
  billing_street: string | null;
  billing_city: string | null;
  billing_postal_code: string | null;
  billing_province: string | null;
};

/** customers row → form values (empty string for missing data). */
export function billingFormValues(row: CustomerRow): Record<string, string> {
  const v = (x: string | null) => x ?? "";
  return {
    fiscalCode: v(row.fiscal_code),
    companyName: v(row.company_name),
    vatNumber: v(row.vat_number),
    sdiCode: v(row.sdi_code),
    pec: v(row.pec),
    street: v(row.billing_street),
    city: v(row.billing_city),
    postalCode: v(row.billing_postal_code),
    province: v(row.billing_province),
  };
}

/** Billing data complete enough for the checkout (D43: private needs CF + address before payment). */
export function billingComplete(row: CustomerRow): boolean {
  return billingSchemaFor(row.customer_type).safeParse(billingFormValues(row)).success;
}

export const PROFILE_MSG = {
  currentPasswordWrong: "La password attuale non è corretta",
  samePassword: "La nuova password deve essere diversa da quella attuale",
  saved: "Dati salvati.",
  passwordChanged: "Password aggiornata.",
  notSaved: "Non è stato possibile salvare i dati. Riprova.",
} as const;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string({ error: MSG.required }).min(1, { error: MSG.required }),
    password,
    passwordConfirm: z.string({ error: MSG.required }),
  })
  .refine((d) => d.password === d.passwordConfirm, { message: MSG.passwordMismatch, path: ["passwordConfirm"] })
  .refine((d) => d.password !== d.currentPassword, { message: PROFILE_MSG.samePassword, path: ["password"] });
