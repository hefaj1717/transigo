"use server";

import { completeProfileUrl, PATHS } from "@/lib/auth/routing";
import { getAccountContext } from "@/lib/auth/session";
import { placeOrder, type SubmitResult } from "@/lib/booking/place-order";
import { quoteBooking } from "@/lib/booking/server";
import { createServiceClient } from "@/lib/supabase/service";

// Saving the order: session checks here, the order logic in placeOrder() (src/lib/booking/place-order.ts).

export type { SubmitResult };

const RETURN_TO_ACCOUNT = `${PATHS.booking}?passo=account`;

export async function submitBooking(raw: unknown): Promise<SubmitResult> {
  // Who: a signed-in, complete, not blocked customer (D8, D70, D80).
  const ctx = await getAccountContext();
  if (ctx.state !== "signed_in") return { status: "redirect", to: `${PATHS.signIn}?next=${encodeURIComponent(RETURN_TO_ACCOUNT)}` };
  if (ctx.isBlocked) return { status: "redirect", to: PATHS.suspended };
  if (ctx.role !== "cliente") return { status: "error", message: "Solo i clienti possono prenotare un trasporto.", step: "account" };
  if (ctx.customerProfile !== "complete" || !ctx.customerType) return { status: "redirect", to: completeProfileUrl(`${PATHS.booking}?passo=riepilogo`) };

  return placeOrder({ db: createServiceClient(), now: new Date(), requote: quoteBooking }, { userId: ctx.userId, customerType: ctx.customerType }, raw);
}

export type CheckoutDefaults = {
  customerType: "private" | "business";
  firstName: string;
  billing: Record<string, string>;
};

/** Prefill for "Riepilogo": billing data from the account (D36). Only for the signed-in customer. */
export async function loadCheckoutDefaults(): Promise<CheckoutDefaults | null> {
  const ctx = await getAccountContext();
  if (ctx.state !== "signed_in" || ctx.isBlocked || ctx.role !== "cliente" || !ctx.customerType) return null;
  const { data } = await createServiceClient()
    .from("customers")
    .select("customer_type, company_name, vat_number, fiscal_code, sdi_code, pec, billing_street, billing_city, billing_postal_code, billing_province")
    .eq("profile_id", ctx.userId)
    .single();
  if (!data) return null;
  const v = (x: string | null) => x ?? "";
  return {
    customerType: data.customer_type,
    firstName: ctx.firstName ?? "",
    billing: {
      fiscalCode: v(data.fiscal_code),
      companyName: v(data.company_name),
      vatNumber: v(data.vat_number),
      sdiCode: v(data.sdi_code),
      pec: v(data.pec),
      street: v(data.billing_street),
      city: v(data.billing_city),
      postalCode: v(data.billing_postal_code),
      province: v(data.billing_province),
    },
  };
}
