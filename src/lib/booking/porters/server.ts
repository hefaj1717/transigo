import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPricingConfig, PricingConfigError } from "../../pricing/load";
import { calculatePortersPrice, type PortersJobTerms } from "../../pricing/porters-service";
import type { PricingConfig, Quote } from "../../pricing/types";
import type { Endpoint } from "../build";
import { toPublicQuote, type PublicQuote } from "../public-quote";
import { quoteValidMinutes, resolveItalianPlace } from "../server";
import { windowRange } from "../windows";
import { toPublicPortersJob, type PortersError, type PublicPortersJob } from "./messages";
import { portersPriceKey, type PortersState } from "./state";

// Server side of the Facchinaggio wizard (D76, D151, D158). Same rules as the transport wizard: the place is
// resolved here from the Google place ID (never from the browser), the price comes from the engine on the active
// price list read with the service role (D59), the full quote (carrier amounts included) is stored in `quotes`
// and the browser gets only toPublicQuote() + the public job terms.

/** What is stored in quotes.input for a porters quote (D76). `kind` keeps it apart from transport quotes. */
export type StoredPortersInput = {
  kind: "porters";
  key: string; // portersPriceKey(state)
  ownerId: string | null; // customer who requested it (null = not signed in); only the owner can order with it
  state: PortersState;
  place: Endpoint;
  window: { date: string; start: string; end: string };
  job: PortersJobTerms;
  now: string;
};

export type PortersQuoteOutcome =
  | { ok: false; error: PortersError }
  | { ok: true; quoteId: string; validUntil: string; quote: PublicQuote; job: PublicPortersJob; city: string };

export type ServerPortersQuote = { quoteId: string; validUntil: Date; quote: Quote; input: StoredPortersInput };

/** Limits of the form from the active price list (null = Facchinaggio not offered). */
export type PortersOptions = { minPersons: number; minHours: number; minLeadHours: number } | null;

export async function loadPortersOptions(db: SupabaseClient): Promise<PortersOptions> {
  try {
    const config = await loadPricingConfig(db);
    return config.portersService ? { minPersons: config.portersService.minPersons, minHours: config.portersService.minHours, minLeadHours: config.minBookingLeadHours } : null;
  } catch (e) {
    if (e instanceof PricingConfigError) return null;
    throw e;
  }
}

/** Prices the wizard state and stores the quote (D76). `customerType` from the account when signed in. */
export async function quotePorters(
  db: SupabaseClient,
  state: PortersState,
  customerType: "private" | "business",
  now: Date = new Date(),
  ownerId: string | null = null,
): Promise<{ outcome: PortersQuoteOutcome; server: ServerPortersQuote | null }> {
  const fail = (error: PortersError) => ({ outcome: { ok: false as const, error }, server: null });
  if (!state.place || !state.date || !state.window) return fail({ code: "incomplete" });
  const range = windowRange(state.date, state.window);
  if (!range) return fail({ code: "invalid_window" });

  let config: PricingConfig;
  try {
    config = await loadPricingConfig(db);
  } catch (e) {
    if (e instanceof PricingConfigError) return fail({ code: "pricing_unavailable" });
    throw e;
  }

  const resolved = await resolveItalianPlace(state.place.placeId);
  if ("error" in resolved) return fail({ code: resolved.error });
  const place = resolved.endpoint;

  const r = calculatePortersPrice(
    {
      customerType,
      now,
      startAt: range.start,
      province: place.province ?? "",
      persons: state.persons,
      hours: state.hours,
      floor: state.place.floor,
      hasElevator: state.place.hasElevator,
    },
    config,
  );
  if (!r.ok) return fail(r.error);

  const validUntil = new Date(now.getTime() + (await quoteValidMinutes(db)) * 60_000);
  const input: StoredPortersInput = {
    kind: "porters",
    key: portersPriceKey(state),
    ownerId,
    state,
    place,
    window: { date: state.date, start: range.start.toISOString(), end: range.end.toISOString() },
    job: r.job,
    now: now.toISOString(),
  };
  const { data, error } = await db
    .from("quotes")
    .insert({ price_list_id: r.quote.priceListId, customer_type: customerType, input, quote: r.quote, created_at: now.toISOString(), valid_until: validUntil.toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  await db.from("quotes").delete().lt("created_at", new Date(now.getTime() - 86_400_000).toISOString()); // D76 housekeeping

  return {
    server: { quoteId: data.id, validUntil, quote: r.quote, input },
    outcome: {
      ok: true,
      quoteId: data.id,
      validUntil: validUntil.toISOString(),
      quote: toPublicQuote(r.quote),
      job: toPublicPortersJob(r.job, r.quote.vatRateBp),
      city: place.city, // shown in the summary; the full address is the customer's own choice
    },
  };
}

/** A stored porters quote, or null when missing or not a porters quote. */
export async function loadStoredPortersQuote(db: SupabaseClient, id: string): Promise<(ServerPortersQuote & { customerType: "private" | "business" }) | null> {
  const { data, error } = await db.from("quotes").select("id, customer_type, input, quote, valid_until").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data || (data.input as { kind?: string })?.kind !== "porters") return null;
  return { quoteId: data.id, validUntil: new Date(data.valid_until), quote: data.quote as Quote, input: data.input as StoredPortersInput, customerType: data.customer_type };
}
