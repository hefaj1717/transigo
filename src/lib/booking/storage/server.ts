import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MapsError } from "../../maps";
import { calculatePrice } from "../../pricing/calculate";
import { loadPricingConfig, PricingConfigError } from "../../pricing/load";
import { PORTER_PACKAGE_LABEL } from "../../pricing/rule-meta";
import { calculateStoragePrice } from "../../pricing/storage-service";
import type { PorterPackageCode, PricingConfig, Quote } from "../../pricing/types";
import type { Endpoint, ResolvedLeg } from "../build";
import { toPublicQuote } from "../public-quote";
import { loadActiveWarehouses, loadFleet, loadWarehouse, quoteValidMinutes, resolveItalianPlace, routeBetween } from "../server";
import type { PublicWarehouse } from "./warehouses";
import { assessVehicles } from "../vehicle-fit";
import { romeToday, windowRange } from "../windows";
import { toPublicStorageQuote, type PublicStoragePart, type PublicStorageQuote, type StorageError, type TransportRole } from "./messages";
import { STORAGE_MAX_PERIOD_DAYS, storagePeriodDays, storagePriceKey, unitFor, type ChainTransportState, type StorageState } from "./state";

// Server side of the Deposito wizard (D76, D151, D153–D158). Same rules as the other wizards: places are resolved
// here from the Google place IDs, the price comes from the engine on the active price list read with the service
// role (D59), the full quote (carrier amounts of the transports included) is stored in `quotes` and the browser gets
// only toPublicStorageQuote(). Capacity (D156) is checked here for the wizard and again by create_service_order()
// under the warehouse lock.

/** Warehouse side of a leg: ground floor with an elevator (no floor surcharge), as the transport wizard. */
const AT_WAREHOUSE = { floor: 0, hasElevator: true };

type StoredLeg = Omit<ResolvedLeg, "windowStart" | "windowEnd"> & { windowStart: string; windowEnd: string };

export type StoredChainTransport = { vehicleTypeId: string; vehicleName: string; leg: StoredLeg; quote: Quote };

/** What is stored in quotes.input for a storage quote (D76). `kind` keeps it apart from the other wizards. */
export type StoredStorageInput = {
  kind: "storage";
  key: string; // storagePriceKey(state, customerType)
  ownerId: string | null; // customer who requested it (null = not signed in); only the owner can order with it
  state: StorageState;
  warehouseId: string;
  days: number;
  storage: Quote; // also in quotes.quote
  transports: Partial<Record<TransportRole, StoredChainTransport>>;
  now: string;
};

export type StorageQuoteOutcome =
  | { ok: false; error: StorageError }
  | { ok: true; quoteId: string; validUntil: string; quote: PublicStorageQuote };

export type ServerStorageQuote = { quoteId: string; validUntil: Date; input: StoredStorageInput };

export type StorageOptions = {
  available: boolean;
  /** Boxes for private customers (D154), price list order; empty = not offered. */
  boxes: { code: string; labelIt: string; volumeM3: number; dayCents: number; monthCents: number }[];
  /** Pallets for businesses (D154, rule storage_pallet_day). */
  pallets: boolean;
  /** Active warehouses the customer picks from (D178). */
  warehouses: PublicWarehouse[];
  porterPackages: { code: PorterPackageCode; labelIt: string; persons: number; includedHours: number }[];
  minLeadHours: number;
  vatRateBp: number;
  quoteValidMinutes: number;
};

const UNAVAILABLE: StorageOptions = {
  available: false, boxes: [], pallets: false, warehouses: [], porterPackages: [], minLeadHours: 3, vatRateBp: 2200, quoteValidMinutes: 30,
};

const enabled = (config: PricingConfig, code: string) => config.rules.some((r) => r.code === code && r.isEnabled);

export async function loadStorageOptions(db: SupabaseClient): Promise<StorageOptions> {
  let config: PricingConfig;
  try {
    config = await loadPricingConfig(db);
  } catch (e) {
    if (e instanceof PricingConfigError) return UNAVAILABLE;
    throw e;
  }
  const [warehouses, validMinutes] = await Promise.all([loadActiveWarehouses(db), quoteValidMinutes(db)]);
  const boxes = config.storageBoxes.filter((b) => b.isEnabled).map(({ code, labelIt, volumeM3, dayCents, monthCents }) => ({ code, labelIt, volumeM3, dayCents, monthCents }));
  const pallets = enabled(config, "storage_pallet_day");
  return {
    available: warehouses.length > 0 && (boxes.length > 0 || pallets),
    boxes,
    pallets,
    warehouses,
    porterPackages: enabled(config, "porter_hour")
      ? config.porterPackages.filter((p) => p.isEnabled).map((p) => ({ code: p.code, labelIt: PORTER_PACKAGE_LABEL[p.code], persons: p.portersCount, includedHours: p.includedHours }))
      : [],
    minLeadHours: config.minBookingLeadHours,
    vatRateBp: config.vatRateBp,
    quoteValidMinutes: validMinutes,
  };
}

// ---------------------------------------------------------------------------
// Period and availability (D156)
// ---------------------------------------------------------------------------

type Period = { start: string; end: string; days: number };

/** The period of the state, checked against today in Rome; an error otherwise. */
export function checkPeriod(state: Pick<StorageState, "startDate" | "endDate">, now: Date): Period | StorageError {
  if (!state.startDate || !state.endDate) return { code: "incomplete" };
  const days = storagePeriodDays(state);
  if (days === null || days > STORAGE_MAX_PERIOD_DAYS || state.startDate < romeToday(now)) return { code: "invalid_period" };
  return { start: state.startDate, end: state.endDate, days };
}

export type StorageUnitChoice = { unit: "box"; boxCode: string } | { unit: "pallet"; pallets: number };

/** The unit of the customer type (D154) from the state, or null when it is missing. */
export function unitChoice(state: StorageState, customerType: "private" | "business"): StorageUnitChoice | null {
  if (unitFor(customerType) === "box") return state.boxCode ? { unit: "box", boxCode: state.boxCode } : null;
  return state.pallets ? { unit: "pallet", pallets: state.pallets } : null;
}

/** Free units of the picked warehouse over the period (warehouse_free_units, service role). */
async function freeUnits(db: SupabaseClient, warehouseId: string, u: StorageUnitChoice, p: Period): Promise<number> {
  const { data, error } = await db.rpc("warehouse_free_units", {
    p_warehouse_id: warehouseId, p_unit: u.unit, p_box_code: u.unit === "box" ? u.boxCode : null, p_start: p.start, p_end: p.end,
  });
  if (error) throw new Error(`warehouse_free_units: ${error.message}`);
  return data as number;
}

const needed = (u: StorageUnitChoice) => (u.unit === "box" ? 1 : u.pallets);

export type AvailabilityOutcome = { ok: true; available: boolean } | { ok: false; error: StorageError };

/** Live availability for the period step (the wizard asks while the customer picks dates). */
export async function storageAvailability(db: SupabaseClient, state: StorageState, customerType: "private" | "business", now = new Date()): Promise<AvailabilityOutcome> {
  const period = checkPeriod(state, now);
  if ("code" in period) return { ok: false, error: period };
  const u = unitChoice(state, customerType);
  if (!u) return { ok: false, error: { code: "incomplete" } };
  const warehouse = state.warehouseId ? await loadWarehouse(db, state.warehouseId) : null;
  if (!warehouse) return { ok: false, error: { code: "no_warehouse" } };
  return { ok: true, available: (await freeUnits(db, warehouse.id, u, period)) >= needed(u) };
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

/** Prices the wizard state and stores the quote (D76). `customerType` from the account when signed in. */
export async function quoteStorage(
  db: SupabaseClient,
  state: StorageState,
  customerType: "private" | "business",
  now: Date = new Date(),
  ownerId: string | null = null,
): Promise<{ outcome: StorageQuoteOutcome; server: ServerStorageQuote | null }> {
  const fail = (error: StorageError) => ({ outcome: { ok: false as const, error }, server: null });
  const u = unitChoice(state, customerType);
  if (!u) return fail({ code: "incomplete" });
  const period = checkPeriod(state, now);
  if ("code" in period) return fail(period);

  let config: PricingConfig;
  try {
    config = await loadPricingConfig(db);
  } catch (e) {
    if (e instanceof PricingConfigError) return fail({ code: "pricing_unavailable" });
    throw e;
  }
  const warehouse = state.warehouseId ? await loadWarehouse(db, state.warehouseId) : null;
  if (!warehouse) return fail({ code: "no_warehouse" });

  const storage = calculateStoragePrice({ customerType, days: period.days, ...u }, config);
  if (!storage.ok) return fail(storage.error.code === "service_unavailable" ? { code: "storage_unavailable" } : { code: "invalid_period" });
  if ((await freeUnits(db, warehouse.id, u, period)) < needed(u)) return fail({ code: "no_space" });

  // Transports of the chain (D153): one leg each, to / from the warehouse of the booking.
  const { id: warehouseId, ...point } = warehouse;
  const warehouseEndpoint: Endpoint = { ...point, warehouseId };
  const fleet = state.intake === "transigo" || state.outbound === "transigo" ? await loadFleet(db, config) : null;
  const transports: StoredStorageInput["transports"] = {};
  for (const role of ["intake", "outbound"] as const) {
    if ((role === "intake" ? state.intake : state.outbound) !== "transigo") continue;
    const t = await quoteTransport(role, role === "intake" ? state.intakeTransport : state.outboundTransport, role === "intake" ? period.start : period.end);
    if ("code" in t) return fail(t);
    transports[role] = t;
  }

  const validUntil = new Date(now.getTime() + (await quoteValidMinutes(db)) * 60_000);
  const input: StoredStorageInput = {
    kind: "storage",
    key: storagePriceKey(state, customerType),
    ownerId,
    state,
    warehouseId,
    days: period.days,
    storage: storage.quote,
    transports,
    now: now.toISOString(),
  };
  const { data, error } = await db
    .from("quotes")
    .insert({ price_list_id: storage.quote.priceListId, customer_type: customerType, input, quote: storage.quote, created_at: now.toISOString(), valid_until: validUntil.toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  await db.from("quotes").delete().lt("created_at", new Date(now.getTime() - 86_400_000).toISOString()); // D76 housekeeping

  return {
    server: { quoteId: data.id, validUntil, input },
    outcome: { ok: true, quoteId: data.id, validUntil: validUntil.toISOString(), quote: publicStorageQuote(input) },
  };

  async function quoteTransport(role: TransportRole, t: ChainTransportState, date: string): Promise<StoredChainTransport | StorageError> {
    if (!t.place || !t.window) return { code: "transport_incomplete", role };
    const range = windowRange(date, t.window);
    if (!range) return { code: "invalid_window", role };
    const resolved = await resolveItalianPlace(t.place.placeId);
    if ("error" in resolved) return resolved.error === "maps_unavailable" ? { code: "maps_unavailable" } : { code: resolved.error, role };
    const customerSide = { endpoint: resolved.endpoint, floor: t.place.floor, hasElevator: t.place.hasElevator };
    const [from, to] = role === "intake"
      ? [customerSide, { endpoint: warehouseEndpoint, ...AT_WAREHOUSE }]
      : [{ endpoint: warehouseEndpoint, ...AT_WAREHOUSE }, customerSide];
    let distanceM: number;
    let durationS: number;
    try {
      ({ distanceM, durationS } = await routeBetween(from.endpoint, to.endpoint));
    } catch (e) {
      if (e instanceof MapsError && e.code === "not_found") return { code: "route_not_found", role };
      console.error("[booking] storage route:", e instanceof Error ? e.message : e);
      return { code: "maps_unavailable" };
    }

    // Vehicle (D82–D86): the recommended one for the goods; businesses carry their pallets.
    const fit = assessVehicles(fleet!.vehicles, {
      weightKg: state.goods.weightKg,
      largestItem: state.goods.largestItem,
      pallets: customerType === "business" ? state.pallets : null,
      loadCategory: state.goods.loadCategory,
    }, fleet!.minimums);
    if (!fit.recommended) return { code: "no_vehicle_fits", role };
    const vehicleTypeId = fit.recommended.vehicleTypeId;

    const r = calculatePrice({
      customerType,
      now,
      legs: [{
        distanceM,
        vehicleTypeId,
        pickupAt: range.start,
        pickupProvince: from.endpoint.province ?? "",
        pickupFloor: from.floor,
        pickupHasElevator: from.hasElevator,
        deliveryFloor: to.floor,
        deliveryHasElevator: to.hasElevator,
      }],
      porters: t.porters ? [{ legIndex: 0, ...t.porters }] : undefined,
    }, config);
    if (!r.ok) return { code: "transport_pricing", role, error: r.error };
    return {
      vehicleTypeId,
      vehicleName: fleet!.vehicles.find((v) => v.id === vehicleTypeId)?.nameIt ?? "",
      leg: {
        pickup: from.endpoint,
        delivery: to.endpoint,
        pickupDate: date,
        windowStart: range.start.toISOString(),
        windowEnd: range.end.toISOString(),
        pickupFloor: from.floor,
        pickupHasElevator: from.hasElevator,
        deliveryFloor: to.floor,
        deliveryHasElevator: to.hasElevator,
        distanceM,
        durationS,
      },
      quote: r.quote,
    };
  }
}

/** The public view of a stored quote: parts in chain order (intake, storage, outbound), customer amounts only. */
export function publicStorageQuote(input: StoredStorageInput): PublicStorageQuote {
  const parts: PublicStoragePart[] = [];
  const transport = (role: TransportRole) => {
    const t = input.transports[role];
    if (t) parts.push({ role, quote: toPublicQuote(t.quote), distanceKm: Math.ceil(t.leg.distanceM / 1000), vehicleName: t.vehicleName });
  };
  transport("intake");
  parts.push({ role: "storage", quote: toPublicQuote(input.storage), distanceKm: null, vehicleName: null });
  transport("outbound");
  return toPublicStorageQuote(parts, input.days);
}

/** Total the customer pays for the stored quote (sum of the orders of the chain, D153). */
export const storedTotalCents = (input: StoredStorageInput) =>
  input.storage.totalCents + (input.transports.intake?.quote.totalCents ?? 0) + (input.transports.outbound?.quote.totalCents ?? 0);

/** A stored storage quote, or null when missing or not a storage quote. */
export async function loadStoredStorageQuote(db: SupabaseClient, id: string): Promise<(ServerStorageQuote & { customerType: "private" | "business" }) | null> {
  const { data, error } = await db.from("quotes").select("id, customer_type, input, valid_until").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data || (data.input as { kind?: string })?.kind !== "storage") return null;
  return { quoteId: data.id, validUntil: new Date(data.valid_until), input: data.input as StoredStorageInput, customerType: data.customer_type };
}
