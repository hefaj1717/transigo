"use server";

import { z } from "zod";
import { completeProfileUrl, PATHS } from "@/lib/auth/routing";
import { getAccountContext } from "@/lib/auth/session";
import { billingDetails, businessBillingSchema, contactsSchema, fieldErrors, privateBillingSchema } from "@/lib/booking/checkout";
import { bookingErrorMessage, bookingErrorStep, type BookingStep } from "@/lib/booking/messages";
import { buildOrderPayload } from "@/lib/booking/order-payload";
import { toPublicQuote, type PublicQuote } from "@/lib/booking/public-quote";
import { loadBookingOptions, loadStoredQuote, quoteBooking, rehydrateLegs, type ServerQuote } from "@/lib/booking/server";
import { priceRelevantKey, wizardStateSchema } from "@/lib/booking/state";
import { createServiceClient } from "@/lib/supabase/service";

// Saving the order (D70, D76, D77). Stage 2b: the order is created as pending_payment; payment arrives
// in Stage 3. Every amount comes from the server-side quote, never from the browser.

export type SubmitResult =
  | { status: "created"; orderNumber: string }
  | { status: "price_changed"; message: string; quoteId: string; validUntil: string; quote: PublicQuote }
  | { status: "redirect"; to: string }
  | { status: "invalid"; fieldErrors: Record<string, string>; message?: string }
  | { status: "error"; message: string; step?: BookingStep };

const bodySchema = z.object({
  state: wizardStateSchema,
  quoteId: z.uuid().nullable(),
  shownTotalCents: z.number().int().min(0),
  contacts: z.record(z.string(), z.string()),
  billing: z.record(z.string(), z.string()),
  acceptTerms: z.boolean(),
});

const RETURN_TO_ACCOUNT = `${PATHS.booking}?passo=account`;
const GENERIC = "Non è stato possibile salvare la prenotazione. Riprova tra poco.";

export async function submitBooking(raw: unknown): Promise<SubmitResult> {
  // 1. Who: a signed-in, complete, not blocked customer (D8, D70, D80).
  const ctx = await getAccountContext();
  if (ctx.state !== "signed_in") return { status: "redirect", to: `${PATHS.signIn}?next=${encodeURIComponent(RETURN_TO_ACCOUNT)}` };
  if (ctx.isBlocked) return { status: "redirect", to: PATHS.suspended };
  if (ctx.role !== "cliente") return { status: "error", message: "Solo i clienti possono prenotare un trasporto.", step: "account" };
  if (ctx.customerProfile !== "complete" || !ctx.customerType) return { status: "redirect", to: completeProfileUrl(`${PATHS.booking}?passo=riepilogo`) };
  const customerType = ctx.customerType;

  // 2. What: shape, contacts, billing, terms.
  const body = bodySchema.safeParse(raw);
  if (!body.success) return { status: "error", message: "Richiesta non valida. Ricarica la pagina e riprova." };
  const { state, quoteId, shownTotalCents } = body.data;

  const contacts = contactsSchema.safeParse(body.data.contacts);
  const billing = (customerType === "private" ? privateBillingSchema : businessBillingSchema).safeParse(body.data.billing);
  const errors: Record<string, string> = {
    ...(contacts.success ? {} : fieldErrors(contacts.error, "contacts.")),
    ...(billing.success ? {} : fieldErrors(billing.error, "billing.")),
  };
  if (!body.data.acceptTerms) errors.acceptTerms = "Devi accettare i Termini e condizioni";
  if (Object.keys(errors).length || !contacts.success || !billing.success) return { status: "invalid", fieldErrors: errors };
  if (!state.goods.description.trim()) return { status: "error", message: "Descrivi la merce da trasportare.", step: "merce" };
  if (!state.vehicleTypeId) return { status: "error", message: "Scegli un veicolo.", step: "veicolo" };

  const db = createServiceClient();
  const now = new Date();
  try {
    const options = await loadBookingOptions(db);
    const errorContext = { maxDistanceKm: options.maxDistanceKm, minLeadHours: options.minLeadHours };

    // 3. Price (D76): the stored quote while valid and unchanged; otherwise a fresh one, shown again if different.
    let quote: ServerQuote | null = null;
    const stored = quoteId ? await loadStoredQuote(db, quoteId) : null;
    if (stored && stored.validUntil > now && stored.customerType === customerType && stored.input.key === priceRelevantKey(state)) {
      quote = stored;
    } else {
      const fresh = await quoteBooking(db, state, customerType, now);
      if (!fresh.outcome.ok) {
        return { status: "error", message: bookingErrorMessage(fresh.outcome.error, errorContext), step: bookingErrorStep(fresh.outcome.error) };
      }
      if (!fresh.server) return { status: "error", message: "Il veicolo scelto non è disponibile. Scegline un altro.", step: "veicolo" };
      quote = fresh.server;
    }
    // The customer confirms exactly the amount shown; any difference is shown again first (D62, D76).
    if (quote.quote.totalCents !== shownTotalCents) {
      return {
        status: "price_changed",
        message: "Il prezzo è stato aggiornato. Controlla il nuovo importo e conferma di nuovo.",
        quoteId: quote.quoteId,
        validUntil: quote.validUntil.toISOString(),
        quote: toPublicQuote(quote.quote),
      };
    }

    // 4. Minimum lead time is checked against the confirmation time, not the quote time (D50, D76).
    const legs = rehydrateLegs(quote.input);
    if (legs.some((l) => l.windowStart.getTime() - now.getTime() < options.minLeadHours * 3_600_000)) {
      return { status: "error", message: bookingErrorMessage({ code: "too_soon", legIndex: 0 }, errorContext), step: "data" };
    }

    // 5. Billing snapshot (D36) and terms version (D42).
    const [{ data: profile, error: profileError }, { data: settings, error: settingsError }] = await Promise.all([
      db.from("profiles").select("first_name, last_name, email").eq("id", ctx.userId).single(),
      db.from("settings").select("terms_version").single(),
    ]);
    if (profileError || settingsError || !profile || !settings) throw profileError ?? settingsError ?? new Error("profile/settings");

    const payload = buildOrderPayload({
      customerId: ctx.userId,
      state: quote.input.state, // the state the quote was computed for (same price-relevant key)
      vehicleTypeId: quote.input.vehicleTypeId,
      legs,
      storageDays: quote.input.storageDays,
      storageBillingUnit: quote.input.storageBillingUnit,
      quote: quote.quote,
      quotedAt: new Date(quote.input.now),
      contacts: contacts.data,
      billingDetails: billingDetails(customerType, { firstName: profile.first_name, lastName: profile.last_name, email: profile.email }, billing.data),
      termsVersion: settings.terms_version,
      termsAcceptedAt: now,
    });
    // Goods text is not price-relevant: take the latest one the customer confirmed.
    payload.goods_description = state.goods.description.trim();
    payload.items_count = state.goods.itemsCount;
    payload.weight_kg = state.goods.weightKg;
    payload.goods_dimensions_note = state.goods.dimensionsNote.trim() || null;

    const { data, error } = await db.rpc("create_order", { p: payload });
    if (error) {
      console.error("[booking] create_order:", { code: error.code, message: error.message });
      return { status: "error", message: GENERIC };
    }
    await db.from("quotes").delete().eq("id", quote.quoteId);
    return { status: "created", orderNumber: (data as { order_number: string }).order_number };
  } catch (e) {
    console.error("[booking] submit:", e instanceof Error ? e.message : e);
    return { status: "error", message: GENERIC };
  }
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
