// Contacts and billing data of the "Contatti" / "Riepilogo" steps (D36, D43, D44). Validated on the server;
// never stored in the browser (D78). Messages in Italian.
import { z } from "zod";
import {
  compactUpper,
  isValidCap,
  isValidCodiceFiscale,
  isValidPartitaIva,
  isValidProvince,
  isValidSdiCode,
  normalizePartitaIva,
  normalizePhone,
  SDI_NO_CHANNEL,
} from "../auth/italian-ids";
import { MSG } from "../auth/schemas";

const text = (max: number) => z.string({ error: MSG.required }).trim().min(1, { error: MSG.required }).max(max, { error: MSG.tooLong });

const phone = z
  .string({ error: MSG.required })
  .trim()
  .min(1, { error: MSG.required })
  .transform((v, ctx) => {
    const e164 = normalizePhone(v);
    if (!e164) ctx.addIssue({ code: "custom", message: MSG.phone });
    return e164 ?? v;
  });

export const contactsSchema = z.object({
  pickupName: text(200),
  pickupPhone: phone,
  deliveryName: text(200),
  deliveryPhone: phone,
  notes: z.string().max(2000, { error: MSG.tooLong }).default(""),
});
export type ContactsInput = z.input<typeof contactsSchema>;

const address = {
  street: text(160),
  city: text(80),
  postalCode: z.string({ error: MSG.required }).trim().refine(isValidCap, { error: MSG.cap }),
  province: z
    .string({ error: MSG.required })
    .transform(compactUpper)
    .pipe(z.string().min(1, { error: MSG.required }).refine(isValidProvince, { error: MSG.province })),
};

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

/** Private customer: codice fiscale and billing address are required before payment (D43). */
export const privateBillingSchema = z.object({
  fiscalCode: z
    .string({ error: MSG.required })
    .transform(compactUpper)
    .pipe(z.string().min(1, { error: MSG.required }).refine(isValidCodiceFiscale, { error: MSG.fiscalCode })),
  ...address,
});

/** Business customer: company data (prefilled from the account, editable for this order — D36, D44). */
export const businessBillingSchema = z
  .object({
    companyName: text(160),
    vatNumber: z
      .string({ error: MSG.required })
      .transform(normalizePartitaIva)
      .pipe(z.string().min(1, { error: MSG.required }).refine(isValidPartitaIva, { error: MSG.vat })),
    sdiCode: optionalSdi,
    pec: optionalPec,
    ...address,
  })
  .superRefine((d, ctx) => {
    if (d.pec) return;
    if (!d.sdiCode) ctx.addIssue({ code: "custom", message: MSG.einvoiceChannel, path: ["sdiCode"] });
    else if (d.sdiCode === SDI_NO_CHANNEL) ctx.addIssue({ code: "custom", message: MSG.pecRequiredWithZeroSdi, path: ["pec"] });
  });

export type BillingInput = Record<string, string>;

/** Snapshot stored in order_charges.billing_details (D36): the profile itself is not changed. */
export function billingDetails(
  customerType: "private" | "business",
  person: { firstName: string | null; lastName: string | null; email: string },
  billing: z.output<typeof privateBillingSchema> | z.output<typeof businessBillingSchema>,
): Record<string, unknown> {
  const addressPart = { street: billing.street, city: billing.city, postal_code: billing.postalCode, province: billing.province, country: "IT" };
  const personPart = { first_name: person.firstName, last_name: person.lastName, email: person.email };
  if (customerType === "private" && "fiscalCode" in billing) {
    return { customer_type: "private", ...personPart, fiscal_code: billing.fiscalCode, ...addressPart };
  }
  if (customerType === "business" && "companyName" in billing) {
    return {
      customer_type: "business",
      ...personPart,
      company_name: billing.companyName,
      vat_number: billing.vatNumber,
      sdi_code: billing.sdiCode ?? null,
      pec: billing.pec ?? null,
      ...addressPart,
    };
  }
  throw new Error("billing data does not match the customer type");
}

/** Flattens zod issues to { field: message } (first message per field). */
export function fieldErrors(error: z.ZodError, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = prefix + (issue.path.join(".") || "_form");
    out[key] ??= issue.message;
  }
  return out;
}
