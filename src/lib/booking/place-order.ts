import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { loadPricingConfig } from "../pricing/load";
import { billingDetails, businessBillingSchema, contactsSchema, fieldErrors, privateBillingSchema } from "./checkout";
import { bookingErrorMessage, bookingErrorStep, type BookingStep } from "./messages";
import { buildOrderPayload } from "./order-payload";
import { toPublicQuote, type PublicQuote } from "./public-quote";
import { loadBookingOptions, loadFleet, loadStoredQuote, rehydrateLegs, vehicleCheck, type quoteBooking, type ServerQuote } from "./server";
import { priceRelevantKey, wizardStateSchema } from "./state";

// Saving the order (D70, D76, D77, D84). Stage 2b: the order is created as pending_payment; payment arrives
// in Stage 3. Every amount comes from a server-side quote, never from the browser.
// Session checks live in the Server Action (submitBooking); this function gets the already verified
// customer and its dependencies, so it can be tested directly against the database (tests/rls/place-order.test.ts).

export type SubmitResult =
  | { status: "created"; orderId: string; orderNumber: string; payment?: { url: string } | { error: string } }
  | { status: "price_changed"; message: string; quoteId: string; validUntil: string; quote: PublicQuote }
  | { status: "redirect"; to: string }
  | { status: "invalid"; fieldErrors: Record<string, string>; message?: string }
  | { status: "error"; message: string; step?: BookingStep };

export type PlaceOrderDeps = {
  db: SupabaseClient; // service role
  now: Date;
  /** Fresh quote (quoteBooking in production; a stub in tests, so no Google calls). */
  requote: (...args: Parameters<typeof quoteBooking>) => ReturnType<typeof quoteBooking>;
};

/** A signed-in, complete, not blocked customer (checked by the caller — D8, D70, D80). */
export type VerifiedCustomer = { userId: string; customerType: "private" | "business" };

const bodySchema = z.object({
  state: wizardStateSchema,
  quoteId: z.uuid().nullable(),
  shownTotalCents: z.number().int().min(0),
  contacts: z.record(z.string(), z.string()),
  billing: z.record(z.string(), z.string()),
  acceptTerms: z.boolean(),
});

const GENERIC = "Non è stato possibile salvare la prenotazione. Riprova tra poco.";

export async function placeOrder(deps: PlaceOrderDeps, customer: VerifiedCustomer, raw: unknown): Promise<SubmitResult> {
  const { customerType } = customer;
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

  const { db, now } = deps;
  try {
    const options = await loadBookingOptions(db);
    const errorContext = { maxDistanceKm: options.maxDistanceKm, minLeadHours: options.minLeadHours };

    // 3. Price (D76): an order is created only from a valid quote of THIS customer, computed for exactly this
    //    route/schedule/services and customer type. A quote of another account is refused; in every other case
    //    the server re-quotes and asks the customer to confirm again — never an order from a stale price.
    const stored = quoteId ? await loadStoredQuote(db, quoteId) : null;
    if (stored && stored.input.ownerId && stored.input.ownerId !== customer.userId) {
      return { status: "error", message: "Questo preventivo non appartiene al tuo account. Ricalcola il prezzo e conferma di nuovo.", step: "preventivo" };
    }
    const usable =
      stored &&
      stored.input.ownerId === customer.userId &&
      stored.validUntil > now &&
      stored.customerType === customerType &&
      stored.input.key === priceRelevantKey(state);
    if (!usable) {
      const fresh = await deps.requote(db, state, customerType, now, customer.userId);
      if (!fresh.outcome.ok) {
        return { status: "error", message: bookingErrorMessage(fresh.outcome.error, errorContext), step: bookingErrorStep(fresh.outcome.error) };
      }
      if (!fresh.server) return { status: "error", message: "Il veicolo scelto non è disponibile. Scegline un altro.", step: "veicolo" };
      const expired = !!stored && stored.validUntil <= now;
      return {
        status: "price_changed",
        message: expired
          ? "Il preventivo è scaduto: abbiamo ricalcolato il prezzo. Controlla l'importo e conferma di nuovo."
          : "Il prezzo è stato aggiornato. Controlla il nuovo importo e conferma di nuovo.",
        quoteId: fresh.server.quoteId,
        validUntil: fresh.server.validUntil.toISOString(),
        quote: toPublicQuote(fresh.server.quote),
      };
    }
    const quote: ServerQuote = stored;
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

    // 4. Vehicle check on current vehicle data (D84): a blocked vehicle can never be booked.
    const config = await loadPricingConfig(db);
    const check = vehicleCheck(state, await loadFleet(db, config));
    const blocked = check.byVehicle[quote.input.vehicleTypeId]?.blocked ?? [];
    if (blocked.length || !check.byVehicle[quote.input.vehicleTypeId]) {
      return { status: "error", message: blocked[0] ?? "Il veicolo scelto non è disponibile. Scegline un altro.", step: "veicolo" };
    }

    // 5. Minimum lead time is checked against the confirmation time, not the quote time (D50, D76).
    const legs = rehydrateLegs(quote.input);
    if (legs.some((l) => l.windowStart.getTime() - now.getTime() < options.minLeadHours * 3_600_000)) {
      return { status: "error", message: bookingErrorMessage({ code: "too_soon", legIndex: 0 }, errorContext), step: "data" };
    }

    // 6. Billing snapshot (D36) and terms version (D42).
    const [{ data: profile, error: profileError }, { data: settings, error: settingsError }] = await Promise.all([
      db.from("profiles").select("first_name, last_name, email").eq("id", customer.userId).single(),
      db.from("settings").select("terms_version").single(),
    ]);
    if (profileError || settingsError || !profile || !settings) throw profileError ?? settingsError ?? new Error("profile/settings");

    const payload = buildOrderPayload({
      customerId: customer.userId,
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
    payload.largest_item_length_cm = state.goods.largestItem.lengthCm;
    payload.largest_item_width_cm = state.goods.largestItem.widthCm;
    payload.largest_item_height_cm = state.goods.largestItem.heightCm;
    payload.pallets_count = state.goods.palletsCount;
    payload.load_category = state.goods.loadCategory;

    const { data, error } = await db.rpc("create_order", { p: payload });
    if (error) {
      console.error("[booking] create_order:", { code: error.code, message: error.message });
      return { status: "error", message: GENERIC };
    }
    await db.from("quotes").delete().eq("id", quote.quoteId);
    const created = data as { id: string; order_number: string };
    return { status: "created", orderId: created.id, orderNumber: created.order_number };
  } catch (e) {
    console.error("[booking] submit:", e instanceof Error ? e.message : e);
    return { status: "error", message: GENERIC };
  }
}
