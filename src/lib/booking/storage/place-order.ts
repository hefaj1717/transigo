import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { loadPricingConfig } from "../../pricing/load";
import { billingDetails, businessBillingSchema, fieldErrors, portersContactsSchema, privateBillingSchema } from "../checkout";
import { storageErrorMessage, storageErrorStep, type PublicStorageQuote, type StorageError, type StorageStep } from "./messages";
import { buildStorageOrderPayload } from "./payload";
import { loadStoredStorageQuote, publicStorageQuote, storedTotalCents, type quoteStorage } from "./server";
import { storagePriceKey, storageStateSchema } from "./state";

// Saving a Deposito order and its chain (D76, D77, D153): created as pending_payment through create_service_order
// (service role, one transaction), only from a valid quote of THIS customer for exactly this state. Session checks
// live in the Server Action; this function gets the verified customer, so it can be tested against the local
// database (tests/rls/place-storage-order.test.ts). The returned id is the root of the chain — the order to pay.

export type StorageSubmitResult =
  | { status: "created"; orderId: string; orderNumber: string; payment?: { url: string } | { error: string } }
  | { status: "price_changed"; message: string; quoteId: string; validUntil: string; quote: PublicStorageQuote }
  | { status: "redirect"; to: string }
  | { status: "invalid"; fieldErrors: Record<string, string>; message?: string }
  | { status: "error"; message: string; step?: StorageStep };

export type PlaceStorageDeps = {
  db: SupabaseClient; // service role
  now: Date;
  /** Fresh quote (quoteStorage in production; a stub in tests, so no Google calls). */
  requote: (...args: Parameters<typeof quoteStorage>) => ReturnType<typeof quoteStorage>;
};

export type VerifiedCustomer = { userId: string; customerType: "private" | "business" };

const bodySchema = z.object({
  state: storageStateSchema,
  quoteId: z.uuid().nullable(),
  shownTotalCents: z.number().int().min(0),
  contacts: z.record(z.string(), z.string()),
  billing: z.record(z.string(), z.string()),
  acceptTerms: z.boolean(),
});

/** Without a transport by Transigo only the notes remain (no on-site contact needed). */
const notesOnlySchema = z.object({ notes: z.string().max(2000).default("") });

const GENERIC = "Non è stato possibile salvare la prenotazione. Riprova tra poco.";
const CHANGED = "Il prezzo è stato aggiornato. Controlla il nuovo importo e conferma di nuovo.";

export async function placeStorageOrder(deps: PlaceStorageDeps, customer: VerifiedCustomer, raw: unknown): Promise<StorageSubmitResult> {
  const { customerType } = customer;
  const body = bodySchema.safeParse(raw);
  if (!body.success) return { status: "error", message: "Richiesta non valida. Ricarica la pagina e riprova." };
  const { state, quoteId, shownTotalCents } = body.data;
  const withTransport = state.intake === "transigo" || state.outbound === "transigo";

  const contacts = withTransport
    ? portersContactsSchema.safeParse(body.data.contacts)
    : notesOnlySchema.transform((c) => ({ ...c, siteName: null, sitePhone: null })).safeParse(body.data.contacts);
  const billing = (customerType === "private" ? privateBillingSchema : businessBillingSchema).safeParse(body.data.billing);
  const errors: Record<string, string> = {
    ...(contacts.success ? {} : fieldErrors(contacts.error, "contacts.")),
    ...(billing.success ? {} : fieldErrors(billing.error, "billing.")),
  };
  if (!body.data.acceptTerms) errors.acceptTerms = "Devi accettare i Termini e condizioni";
  if (Object.keys(errors).length || !contacts.success || !billing.success) return { status: "invalid", fieldErrors: errors };
  const description = state.goods.description.trim();
  if (!description) return { status: "error", message: "Descrivi cosa vuoi depositare.", step: "merce" };

  const { db, now } = deps;
  try {
    const config = await loadPricingConfig(db);
    const ctx = { minLeadHours: config.minBookingLeadHours };
    const error = (e: StorageError): StorageSubmitResult => ({ status: "error", message: storageErrorMessage(e, ctx), step: storageErrorStep(e) });

    // Price (D76): an order only from a valid quote of THIS customer for exactly this state and customer type;
    // a quote of another account is refused, anything else is re-quoted and shown again.
    const stored = quoteId ? await loadStoredStorageQuote(db, quoteId) : null;
    if (stored && stored.input.ownerId && stored.input.ownerId !== customer.userId) {
      return { status: "error", message: "Questo preventivo non appartiene al tuo account. Ricalcola il prezzo e conferma di nuovo.", step: "preventivo" };
    }
    const usable =
      stored && stored.input.ownerId === customer.userId && stored.validUntil > now && stored.customerType === customerType
      && stored.input.key === storagePriceKey(state, customerType);
    if (!usable) {
      const fresh = await deps.requote(db, state, customerType, now, customer.userId);
      if (!fresh.outcome.ok || !fresh.server) return error(fresh.outcome.ok ? { code: "pricing_unavailable" } : fresh.outcome.error);
      return {
        status: "price_changed",
        message: stored && stored.validUntil <= now ? "Il preventivo è scaduto: abbiamo ricalcolato il prezzo. Controlla l'importo e conferma di nuovo." : CHANGED,
        quoteId: fresh.server.quoteId,
        validUntil: fresh.server.validUntil.toISOString(),
        quote: publicStorageQuote(fresh.server.input),
      };
    }
    const input = stored.input;
    if (storedTotalCents(input) !== shownTotalCents) {
      return { status: "price_changed", message: CHANGED, quoteId: stored.quoteId, validUntil: stored.validUntil.toISOString(), quote: publicStorageQuote(input) };
    }

    // Minimum lead time of the pickup against the confirmation time, not the quote time (D50, D76).
    const intake = input.transports.intake;
    if (intake && new Date(intake.leg.windowStart).getTime() - now.getTime() < ctx.minLeadHours * 3_600_000) {
      return error({ code: "transport_pricing", role: "intake", error: { code: "too_soon", legIndex: 0 } });
    }

    const [{ data: profile, error: profileError }, { data: settings, error: settingsError }, { data: warehouse, error: warehouseError }] = await Promise.all([
      db.from("profiles").select("first_name, last_name, email").eq("id", customer.userId).single(),
      db.from("settings").select("terms_version, company_phone").single(),
      db.from("warehouses").select("name").eq("id", input.warehouseId).single(),
    ]);
    if (profileError || settingsError || warehouseError || !profile || !settings || !warehouse) throw profileError ?? settingsError ?? warehouseError ?? new Error("profile/settings/warehouse");

    const { siteName, sitePhone } = contacts.data;
    const site = siteName && sitePhone ? { name: siteName, phone: sitePhone } : null;
    const payload = buildStorageOrderPayload({
      customerId: customer.userId,
      customerType,
      input,
      siteContact: site,
      // The warehouse end of a transport: Transigo (company phone; the customer's contact when it is not set yet).
      warehouseContact: { name: warehouse.name, phone: settings.company_phone ?? site?.phone ?? "" },
      notes: contacts.data.notes ?? "",
      description, // not price-relevant: the latest text the customer confirmed
      billingDetails: billingDetails(customerType, { firstName: profile.first_name, lastName: profile.last_name, email: profile.email }, billing.data),
      termsVersion: settings.terms_version,
      termsAcceptedAt: now,
    });

    const { data, error: dbError } = await db.rpc("create_service_order", { p: payload });
    if (dbError) {
      if (dbError.code === "23P01") return error({ code: "no_space" }); // the last unit went meanwhile (D156)
      console.error("[booking] create_service_order (storage):", { code: dbError.code, message: dbError.message });
      return { status: "error", message: GENERIC };
    }
    await db.from("quotes").delete().eq("id", stored.quoteId);
    const created = data as { id: string; order_number: string };
    return { status: "created", orderId: created.id, orderNumber: created.order_number };
  } catch (e) {
    console.error("[booking] storage submit:", e instanceof Error ? e.message : e);
    return { status: "error", message: GENERIC };
  }
}
