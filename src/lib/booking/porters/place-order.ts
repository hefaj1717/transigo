import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { loadPricingConfig } from "../../pricing/load";
import { billingDetails, businessBillingSchema, fieldErrors, portersContactsSchema, privateBillingSchema } from "../checkout";
import { toPublicQuote, type PublicQuote } from "../public-quote";
import { portersErrorMessage, portersErrorStep, toPublicPortersJob, type PortersStep, type PublicPortersJob } from "./messages";
import { buildPortersOrderPayload } from "./payload";
import { loadStoredPortersQuote, type quotePorters, type ServerPortersQuote } from "./server";
import { portersPriceKey, portersStateSchema } from "./state";

// Saving a Facchinaggio order (D76, D77, D151): the order is created as pending_payment through
// create_service_order (service role), only from a valid quote of THIS customer for exactly this state.
// Session checks live in the Server Action; this function gets the verified customer, so it can be tested
// against the local database (tests/rls/place-porters-order.test.ts).

export type PortersSubmitResult =
  | { status: "created"; orderId: string; orderNumber: string; payment?: { url: string } | { error: string } }
  | { status: "price_changed"; message: string; quoteId: string; validUntil: string; quote: PublicQuote; job: PublicPortersJob }
  | { status: "redirect"; to: string }
  | { status: "invalid"; fieldErrors: Record<string, string>; message?: string }
  | { status: "error"; message: string; step?: PortersStep };

export type PlacePortersDeps = {
  db: SupabaseClient; // service role
  now: Date;
  /** Fresh quote (quotePorters in production; a stub in tests, so no Google calls). */
  requote: (...args: Parameters<typeof quotePorters>) => ReturnType<typeof quotePorters>;
};

export type VerifiedCustomer = { userId: string; customerType: "private" | "business" };

const bodySchema = z.object({
  state: portersStateSchema,
  quoteId: z.uuid().nullable(),
  shownTotalCents: z.number().int().min(0),
  contacts: z.record(z.string(), z.string()),
  billing: z.record(z.string(), z.string()),
  acceptTerms: z.boolean(),
});

const GENERIC = "Non è stato possibile salvare la prenotazione. Riprova tra poco.";
const CHANGED = "Il prezzo è stato aggiornato. Controlla il nuovo importo e conferma di nuovo.";

export async function placePortersOrder(deps: PlacePortersDeps, customer: VerifiedCustomer, raw: unknown): Promise<PortersSubmitResult> {
  const { customerType } = customer;
  const body = bodySchema.safeParse(raw);
  if (!body.success) return { status: "error", message: "Richiesta non valida. Ricarica la pagina e riprova." };
  const { state, quoteId, shownTotalCents } = body.data;

  const contacts = portersContactsSchema.safeParse(body.data.contacts);
  const billing = (customerType === "private" ? privateBillingSchema : businessBillingSchema).safeParse(body.data.billing);
  const errors: Record<string, string> = {
    ...(contacts.success ? {} : fieldErrors(contacts.error, "contacts.")),
    ...(billing.success ? {} : fieldErrors(billing.error, "billing.")),
  };
  if (!body.data.acceptTerms) errors.acceptTerms = "Devi accettare i Termini e condizioni";
  if (Object.keys(errors).length || !contacts.success || !billing.success) return { status: "invalid", fieldErrors: errors };
  const description = state.description.trim();
  if (!description) return { status: "error", message: "Descrivi cosa c'è da spostare.", step: "cosa" };

  const { db, now } = deps;
  try {
    const config = await loadPricingConfig(db);
    const ctx = {
      minLeadHours: config.minBookingLeadHours,
      minPersons: config.portersService?.minPersons ?? 2,
      minHours: config.portersService?.minHours ?? 1,
    };

    // Price (D76): an order only from a valid quote of THIS customer for exactly this state and customer type;
    // a quote of another account is refused, anything else is re-quoted and shown again.
    const stored = quoteId ? await loadStoredPortersQuote(db, quoteId) : null;
    if (stored && stored.input.ownerId && stored.input.ownerId !== customer.userId) {
      return { status: "error", message: "Questo preventivo non appartiene al tuo account. Ricalcola il prezzo e conferma di nuovo.", step: "preventivo" };
    }
    const usable =
      stored && stored.input.ownerId === customer.userId && stored.validUntil > now && stored.customerType === customerType && stored.input.key === portersPriceKey(state);
    if (!usable) {
      const fresh = await deps.requote(db, state, customerType, now, customer.userId);
      if (!fresh.outcome.ok || !fresh.server) {
        const error = fresh.outcome.ok ? ({ code: "pricing_unavailable" } as const) : fresh.outcome.error;
        return { status: "error", message: portersErrorMessage(error, ctx), step: portersErrorStep(error) };
      }
      return {
        status: "price_changed",
        message: stored && stored.validUntil <= now ? "Il preventivo è scaduto: abbiamo ricalcolato il prezzo. Controlla l'importo e conferma di nuovo." : CHANGED,
        quoteId: fresh.server.quoteId,
        validUntil: fresh.server.validUntil.toISOString(),
        quote: toPublicQuote(fresh.server.quote),
        job: toPublicPortersJob(fresh.server.input.job, fresh.server.quote.vatRateBp),
      };
    }
    const quote: ServerPortersQuote = stored;
    if (quote.quote.totalCents !== shownTotalCents) {
      return {
        status: "price_changed", message: CHANGED, quoteId: quote.quoteId, validUntil: quote.validUntil.toISOString(),
        quote: toPublicQuote(quote.quote), job: toPublicPortersJob(quote.input.job, quote.quote.vatRateBp),
      };
    }

    // Minimum lead time against the confirmation time, not the quote time (D50, D76).
    const start = new Date(quote.input.window.start);
    if (start.getTime() - now.getTime() < ctx.minLeadHours * 3_600_000) {
      return { status: "error", message: portersErrorMessage({ code: "too_soon", legIndex: 0 }, ctx), step: "data" };
    }

    const [{ data: profile, error: profileError }, { data: settings, error: settingsError }] = await Promise.all([
      db.from("profiles").select("first_name, last_name, email").eq("id", customer.userId).single(),
      db.from("settings").select("terms_version").single(),
    ]);
    if (profileError || settingsError || !profile || !settings) throw profileError ?? settingsError ?? new Error("profile/settings");

    const payload = buildPortersOrderPayload({
      customerId: customer.userId,
      state: quote.input.state, // the state the quote was computed for (same price key)
      place: quote.input.place,
      window: { date: quote.input.window.date, start, end: new Date(quote.input.window.end) },
      quote: quote.quote,
      job: quote.input.job,
      quotedAt: new Date(quote.input.now),
      contacts: contacts.data,
      description, // not price-relevant: the latest text the customer confirmed
      billingDetails: billingDetails(customerType, { firstName: profile.first_name, lastName: profile.last_name, email: profile.email }, billing.data),
      termsVersion: settings.terms_version,
      termsAcceptedAt: now,
    });

    const { data, error } = await db.rpc("create_service_order", { p: payload });
    if (error) {
      console.error("[booking] create_service_order (porters):", { code: error.code, message: error.message });
      return { status: "error", message: GENERIC };
    }
    await db.from("quotes").delete().eq("id", quote.quoteId);
    const created = data as { id: string; order_number: string };
    return { status: "created", orderId: created.id, orderNumber: created.order_number };
  } catch (e) {
    console.error("[booking] porters submit:", e instanceof Error ? e.message : e);
    return { status: "error", message: GENERIC };
  }
}
