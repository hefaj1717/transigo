import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMapsProvider, MapsError, type PlaceDetails, type RoutePoint, type RouteResult } from "../maps";
import { calculatePrice } from "../pricing/calculate";
import { loadPricingConfig, PricingConfigError } from "../pricing/load";
import { PORTER_PACKAGE_LABEL } from "../pricing/rule-meta";
import type { PorterPackageCode, PricingConfig, Quote, StorageBillingUnit } from "../pricing/types";
import { planLegs, priceInputFor, type Endpoint, type ResolvedLeg, type WarehousePoint } from "./build";
import type { BookingError } from "./messages";
import { headlineCents, toPublicQuote, type PublicPorterTerms, type PublicQuote } from "./public-quote";
import { loadNeeds, priceRelevantKey, type WizardState } from "./state";
import {
  assessVehicles,
  belowMinimumText,
  blockText,
  NO_VEHICLE_FITS,
  recommendationText,
  type CategoryMinimums,
  type VehicleCapacity,
} from "./vehicle-fit";

// Server side of the booking wizard (D72, D76). Reads price tables and settings with the service-role
// client (D59) — callers pass createServiceClient(). Places and routes are always resolved here; the
// browser only sends Google place IDs.

// ---------------------------------------------------------------------------
// Options shown by the wizard
// ---------------------------------------------------------------------------

export type BookingOptions = {
  available: boolean; // false: no active price list (wizard shows a message)
  /** Active, priced vehicle types with their capacity (D81), smallest first. */
  vehicles: (VehicleCapacity & { volumeDm3: number | null })[];
  porterPackages: { code: PorterPackageCode; labelIt: string; persons: number; includedHours: number }[];
  /** D182: help at loading / unloading (rule porter_hour enabled). */
  loadingHelpAvailable: boolean;
  packingAvailable: boolean;
  /** maxDays: last day for the pickup from the warehouse, counted from the first pickup (D117: short-term only). */
  storage: { available: boolean; billingUnit: StorageBillingUnit; warehouseCity: string | null; maxDays: number };
  minLeadHours: number;
  maxDistanceKm: number;
  quoteValidMinutes: number;
};

export async function loadActiveWarehouse(db: SupabaseClient): Promise<WarehousePoint | null> {
  const { data, error } = await db
    .from("warehouses")
    .select("id, address, place_id, lat, lng, city, postal_code, province")
    .eq("is_active", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return toWarehousePoint(data);
}

type WarehouseRow = { id: string; address: string; place_id: string | null; lat: number; lng: number; city: string; postal_code: string | null; province: string };

/** One active warehouse by id (D178: the one the customer picked), or null when unknown or inactive. */
export async function loadWarehouse(db: SupabaseClient, id: string): Promise<WarehousePoint | null> {
  const { data, error } = await db
    .from("warehouses")
    .select("id, address, place_id, lat, lng, city, postal_code, province")
    .eq("id", id)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data ? toWarehousePoint(data) : null;
}

/** Active warehouses for the Deposito wizard (D178): what the customer sees, nothing internal. */
export async function loadActiveWarehouses(db: SupabaseClient): Promise<{ id: string; name: string; address: string; city: string; province: string }[]> {
  const { data, error } = await db.from("warehouses").select("id, name, address, city, province").eq("is_active", true).order("city");
  if (error) throw error;
  return data ?? [];
}

function toWarehousePoint(data: WarehouseRow): WarehousePoint {
  return {
    id: data.id,
    address: data.address,
    placeId: data.place_id,
    lat: data.lat,
    lng: data.lng,
    city: data.city,
    postalCode: data.postal_code,
    province: data.province,
  };
}

export async function quoteValidMinutes(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.from("settings").select("quote_valid_minutes").single();
  if (error) throw error;
  return data.quote_valid_minutes as number;
}

const enabled = (config: PricingConfig, code: string) => config.rules.some((r) => r.code === code && r.isEnabled);

export async function loadBookingOptions(db: SupabaseClient): Promise<BookingOptions> {
  let config: PricingConfig;
  try {
    config = await loadPricingConfig(db);
  } catch (e) {
    if (!(e instanceof PricingConfigError)) throw e;
    console.error("[booking] options:", e.message);
    return {
      available: false,
      vehicles: [],
      porterPackages: [],
      loadingHelpAvailable: false,
      packingAvailable: false,
      storage: { available: false, billingUnit: "pallet_day", warehouseCity: null, maxDays: 0 },
      minLeadHours: 3,
      maxDistanceKm: 300,
      quoteValidMinutes: 30,
    };
  }

  const [fleet, warehouse, validMinutes] = await Promise.all([loadFleet(db, config), loadActiveWarehouse(db), quoteValidMinutes(db)]);
  const perPallet = config.storageBillingUnit === "pallet_day";
  return {
    available: true,
    vehicles: fleet.vehicles,
    porterPackages: enabled(config, "porter_hour")
      ? config.porterPackages.filter((p) => p.isEnabled).map((p) => ({ code: p.code, labelIt: PORTER_PACKAGE_LABEL[p.code], persons: p.portersCount, includedHours: p.includedHours }))
      : [],
    loadingHelpAvailable: enabled(config, "porter_hour"),
    packingAvailable: enabled(config, "packing_flat") || enabled(config, "packing_per_item"),
    storage: {
      available: !!warehouse && enabled(config, perPallet ? "storage_pallet_day" : "storage_day"),
      billingUnit: config.storageBillingUnit,
      warehouseCity: warehouse?.city ?? null,
      maxDays: config.storageShortTermMaxDays,
    },
    minLeadHours: config.minBookingLeadHours,
    maxDistanceKm: Math.floor(config.maxRouteDistanceM / 1000),
    quoteValidMinutes: validMinutes,
  };
}

/**
 * Vehicles the customer can book (active and priced in `config`), with capacities (D81), and the minimum
 * vehicle per load category (D83). Always read fresh: the vehicle check uses current data (D84).
 */
export async function loadFleet(
  db: SupabaseClient,
  config: PricingConfig,
): Promise<{ vehicles: (VehicleCapacity & { volumeDm3: number | null })[]; minimums: CategoryMinimums }> {
  const [types, minimums] = await Promise.all([
    db
      .from("vehicle_types")
      .select("id, size_rank, payload_kg, cargo_length_cm, cargo_width_cm, cargo_height_cm, cargo_volume_dm3, euro_pallets")
      .eq("is_active", true)
      .order("size_rank"),
    db.from("porter_package_min_vehicle").select("package_code, vehicle_type_id"),
  ]);
  if (types.error) throw types.error;
  if (minimums.error) throw minimums.error;
  const priced = new Map(config.vehicleRates.map((r) => [r.vehicleTypeId, r]));
  return {
    vehicles: (types.data ?? [])
      .filter((t) => priced.has(t.id))
      .map((t) => ({
        id: t.id,
        nameIt: priced.get(t.id)!.nameIt,
        sizeRank: t.size_rank,
        payloadKg: t.payload_kg,
        lengthCm: t.cargo_length_cm,
        widthCm: t.cargo_width_cm,
        heightCm: t.cargo_height_cm,
        euroPallets: t.euro_pallets,
        volumeDm3: t.cargo_volume_dm3,
      })),
    minimums: Object.fromEntries((minimums.data ?? []).map((m) => [m.package_code, m.vehicle_type_id])) as CategoryMinimums,
  };
}

export type VehicleCheck = {
  recommended: { vehicleTypeId: string; reason: string } | null;
  /** Per vehicle: why it cannot be chosen (D84) and a warning below the category minimum (D83). */
  byVehicle: Record<string, { blocked: string[]; warning: string | null }>;
  noneFits: string | null;
};

/** Runs the vehicle check (D82–D85) and turns it into Italian texts for the wizard. */
export function vehicleCheck(state: WizardState, fleet: Awaited<ReturnType<typeof loadFleet>>): VehicleCheck {
  const needs = loadNeeds(state);
  const fit = assessVehicles(fleet.vehicles, needs, fleet.minimums);
  const byVehicle: VehicleCheck["byVehicle"] = {};
  fit.assessments.forEach((a, i) => {
    const v = fleet.vehicles[i];
    byVehicle[a.vehicleTypeId] = {
      blocked: a.blockedBy.map((r) => blockText(r, v)),
      warning: a.belowCategoryMinimum && needs.loadCategory ? belowMinimumText(needs.loadCategory) : null,
    };
  });
  return {
    recommended: fit.recommended ? { vehicleTypeId: fit.recommended.vehicleTypeId, reason: recommendationText(fit.recommended.reason) } : null,
    byVehicle,
    noneFits: fit.recommended ? null : NO_VEHICLE_FITS,
  };
}

// ---------------------------------------------------------------------------
// Google lookups with a small in-memory cache (per server instance) — the wizard re-quotes often
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { value: unknown; expires: number }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await load();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

function toEndpoint(p: PlaceDetails): Endpoint {
  return {
    address: p.formattedAddress,
    placeId: p.placeId,
    lat: p.location.lat,
    lng: p.location.lng,
    city: p.city ?? p.formattedAddress,
    postalCode: p.postalCode,
    province: p.provinceCode,
    warehouseId: null,
  };
}

/**
 * One Google place resolved on the server (D76), Italy only — shared by the wizards without a route (Facchinaggio).
 * Errors: not_found → place_not_found; other → maps_unavailable (logged).
 */
export async function resolveItalianPlace(placeId: string): Promise<{ endpoint: Endpoint } | { error: "place_not_found" | "not_italy" | "maps_unavailable" }> {
  try {
    const place = await cached(`place:${placeId}`, () => getMapsProvider().placeDetails(placeId));
    if (place.countryCode !== "IT") return { error: "not_italy" };
    return { endpoint: toEndpoint(place) };
  } catch (e) {
    if (e instanceof MapsError && e.code === "not_found") return { error: "place_not_found" };
    console.error("[booking] maps:", e instanceof Error ? e.message : e);
    return { error: "maps_unavailable" };
  }
}

const point = (e: Endpoint): RoutePoint => (e.placeId && !e.warehouseId ? { placeId: e.placeId } : { lat: e.lat, lng: e.lng });

/** Route between two resolved endpoints (cached like the transport wizard) — single legs of the Deposito chain (D153). */
export function routeBetween(from: Endpoint, to: Endpoint): Promise<RouteResult> {
  const a = point(from);
  const z = point(to);
  return cached<RouteResult>(`route:${JSON.stringify([a, z])}`, () => getMapsProvider().computeRoute(a, z));
}

/**
 * Cities, provinces and route length for an "out of area" contact request (D125, spec 2a). Resolved on the
 * server from the place IDs (D76: never taken from the browser). Only cities and provinces leave this
 * function — no street addresses. A maps error leaves the fields empty: the request is still saved.
 */
export async function resolveRouteSummary(pickupPlaceId: string, deliveryPlaceId: string): Promise<{
  pickupCity: string | null; pickupProvince: string | null; deliveryCity: string | null; deliveryProvince: string | null; distanceKm: number | null;
}> {
  const maps = getMapsProvider();
  const place = (id: string) => cached(`place:${id}`, () => maps.placeDetails(id)).catch(() => null);
  const [a, b] = await Promise.all([place(pickupPlaceId), place(deliveryPlaceId)]);
  let distanceKm: number | null = null;
  if (a && b) {
    const from: RoutePoint = { placeId: a.placeId };
    const to: RoutePoint = { placeId: b.placeId };
    const r = await cached<RouteResult>(`route:${JSON.stringify([from, to])}`, () => maps.computeRoute(from, to)).catch(() => null);
    if (r) distanceKm = Math.round(r.distanceM / 1000); // whole km, display only
  }
  return {
    pickupCity: a?.city ?? null,
    pickupProvince: a?.provinceCode ?? null,
    deliveryCity: b?.city ?? null,
    deliveryProvince: b?.provinceCode ?? null,
    distanceKm,
  };
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

export type VehiclePrice = { vehicleTypeId: string; headlineCents: number } | { vehicleTypeId: string; error: BookingError };

/** What is stored in quotes.input (D76): enough to create the order without asking Google again. */
export type StoredQuoteInput = {
  key: string; // priceRelevantKey(state)
  /** Customer who requested the quote (null = not signed in). Only the owner can order with it (D76). */
  ownerId: string | null;
  state: WizardState;
  vehicleTypeId: string;
  storageDays: number | null;
  storageBillingUnit: StorageBillingUnit;
  legs: (Omit<ResolvedLeg, "windowStart" | "windowEnd"> & { windowStart: string; windowEnd: string })[];
  now: string;
};

export type QuoteOutcome =
  | { ok: false; error: BookingError }
  | {
      ok: true;
      distancesKm: number[];
      vehicles: VehiclePrice[];
      /** Recommendation and blocks (D82–D85). */
      fit: VehicleCheck;
      /** Porter terms (same for every vehicle), for the sentence under the porter choice (D67, D68). */
      porters: PublicPorterTerms[];
      /** Only when a priced vehicle is selected. */
      selected: { quoteId: string; validUntil: string; quote: PublicQuote } | null;
    };

/** Full result for the server (submit), with the engine Quote and resolved legs. */
export type ServerQuote = { quoteId: string; validUntil: Date; quote: Quote; input: StoredQuoteInput };

const VEHICLE_INDEPENDENT = new Set(["pickup_province", "max_distance", "too_soon", "service_unavailable", "invalid_input"]);

function mapsError(e: unknown, which: "pickup" | "delivery" | null, legIndex = 0): BookingError {
  if (e instanceof MapsError && e.code === "not_found") return which ? { code: "place_not_found", which } : { code: "route_not_found", legIndex };
  console.error("[booking] maps:", e instanceof Error ? e.message : e);
  return { code: "maps_unavailable" };
}

/**
 * Prices the wizard state for every vehicle; when state.vehicleTypeId is priced, stores that quote (D76).
 * `customerType` comes from the account when signed in, otherwise from the Privato/Azienda toggle.
 */
export async function quoteBooking(
  db: SupabaseClient,
  state: WizardState,
  customerType: "private" | "business",
  now: Date = new Date(),
  ownerId: string | null = null,
): Promise<{ outcome: QuoteOutcome; server: ServerQuote | null }> {
  const fail = (error: BookingError) => ({ outcome: { ok: false as const, error }, server: null });
  if (!state.pickup || !state.delivery || !state.pickupDate || !state.pickupWindow) return fail({ code: "incomplete" });

  let config: PricingConfig;
  try {
    config = await loadPricingConfig(db);
  } catch (e) {
    if (e instanceof PricingConfigError) return fail({ code: "pricing_unavailable" });
    throw e;
  }

  const maps = getMapsProvider();
  const resolve = async (placeId: string, which: "pickup" | "delivery") => {
    try {
      const place = await cached(`place:${placeId}`, () => maps.placeDetails(placeId));
      if (place.countryCode !== "IT") return { error: { code: "not_italy", which } as BookingError };
      return { endpoint: toEndpoint(place) };
    } catch (e) {
      return { error: mapsError(e, which) };
    }
  };
  const [pickup, delivery, warehouse] = await Promise.all([
    resolve(state.pickup.placeId, "pickup"),
    resolve(state.delivery.placeId, "delivery"),
    state.storage ? loadActiveWarehouse(db) : Promise.resolve(null),
  ]);
  if ("error" in pickup && pickup.error) return fail(pickup.error);
  if ("error" in delivery && delivery.error) return fail(delivery.error);

  // D117: "stoccaggio lungo termine" is not offered until each leg is a separate job (model B, before Stage 7).
  const plan = planLegs(state, pickup.endpoint!, delivery.endpoint!, warehouse, config.storageShortTermMaxDays);
  if (!plan.ok) return fail({ code: plan.error });

  let legs: ResolvedLeg[];
  try {
    legs = await Promise.all(
      plan.legs.map(async (l) => {
        const from = point(l.pickup);
        const to = point(l.delivery);
        const r = await cached<RouteResult>(`route:${JSON.stringify([from, to])}`, () => maps.computeRoute(from, to));
        return { ...l, distanceM: r.distanceM, durationS: r.durationS };
      }),
    );
  } catch (e) {
    return fail(mapsError(e, null));
  }

  const priceWith = (vehicleTypeId: string) =>
    calculatePrice(
      priceInputFor({ state, legs, storageDays: plan.storageDays, storageBillingUnit: config.storageBillingUnit, vehicleTypeId, customerType, now }),
      config,
    );

  const fit = vehicleCheck(state, await loadFleet(db, config));
  const isBlocked = (id: string) => (fit.byVehicle[id]?.blocked.length ?? 0) > 0;

  const vehicles: VehiclePrice[] = [];
  let anyQuote: Quote | null = null;
  let selectedQuote: Quote | null = null;
  for (const rate of config.vehicleRates) {
    const r = priceWith(rate.vehicleTypeId);
    if (!r.ok) {
      if (VEHICLE_INDEPENDENT.has(r.error.code)) return fail(r.error); // the same for every vehicle
      vehicles.push({ vehicleTypeId: rate.vehicleTypeId, error: r.error });
      continue;
    }
    anyQuote ??= r.quote;
    // A blocked vehicle (D84) never gets a stored quote, so it cannot be booked.
    if (rate.vehicleTypeId === state.vehicleTypeId && !isBlocked(rate.vehicleTypeId)) selectedQuote = r.quote;
    vehicles.push({ vehicleTypeId: rate.vehicleTypeId, headlineCents: headlineCents(r.quote) });
  }
  if (!anyQuote) return fail({ code: "pricing_unavailable" });

  let server: ServerQuote | null = null;
  if (selectedQuote && state.vehicleTypeId) {
    const validUntil = new Date(now.getTime() + (await quoteValidMinutes(db)) * 60_000);
    const input: StoredQuoteInput = {
      key: priceRelevantKey(state),
      ownerId,
      state,
      vehicleTypeId: state.vehicleTypeId,
      storageDays: plan.storageDays,
      storageBillingUnit: config.storageBillingUnit,
      legs: legs.map((l) => ({ ...l, windowStart: l.windowStart.toISOString(), windowEnd: l.windowEnd.toISOString() })),
      now: now.toISOString(),
    };
    const { data, error } = await db
      .from("quotes")
      .insert({ price_list_id: selectedQuote.priceListId, customer_type: customerType, input, quote: selectedQuote, created_at: now.toISOString(), valid_until: validUntil.toISOString() })
      .select("id")
      .single();
    if (error) throw error;
    // Housekeeping (D76): quotes older than 24 h are no longer needed.
    await db.from("quotes").delete().lt("created_at", new Date(now.getTime() - 86_400_000).toISOString());
    server = { quoteId: data.id, validUntil, quote: selectedQuote, input };
  }

  return {
    server,
    outcome: {
      ok: true,
      distancesKm: legs.map((l) => Math.ceil(l.distanceM / 1000)),
      vehicles,
      fit,
      porters: toPublicQuote(anyQuote).porters,
      selected: server ? { quoteId: server.quoteId, validUntil: server.validUntil.toISOString(), quote: toPublicQuote(server.quote) } : null,
    },
  };
}

/** A stored quote (D76), or null when it does not exist. */
export async function loadStoredQuote(db: SupabaseClient, id: string): Promise<(ServerQuote & { customerType: "private" | "business" }) | null> {
  const { data, error } = await db.from("quotes").select("id, customer_type, input, quote, valid_until").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data || (data.input as { kind?: string })?.kind) return null; // another wizard's quote (porters, storage)
  return { quoteId: data.id, validUntil: new Date(data.valid_until), quote: data.quote as Quote, input: data.input as StoredQuoteInput, customerType: data.customer_type };
}

export function rehydrateLegs(input: StoredQuoteInput): ResolvedLeg[] {
  return input.legs.map((l) => ({ ...l, windowStart: new Date(l.windowStart), windowEnd: new Date(l.windowEnd) }));
}
