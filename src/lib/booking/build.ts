// From the wizard state + places/routes resolved by the server to the engine input (PriceInput) and the
// legs stored with the order. Pure; the server-side I/O lives in server.ts.
import type { PriceInput, PorterRequest, StorageBillingUnit } from "../pricing/types";
import type { WizardState } from "./state";
import { daysBetween, windowRange } from "./windows";

/** A place resolved by the server (Google Place Details) or the warehouse. */
export type Endpoint = {
  address: string;
  placeId: string | null;
  lat: number;
  lng: number;
  city: string;
  postalCode: string | null;
  province: string | null; // sigla
  warehouseId: string | null;
};

export type WarehousePoint = Omit<Endpoint, "warehouseId"> & { id: string };

/** One leg as planned before routing (D47). */
export type LegPlan = {
  pickup: Endpoint;
  delivery: Endpoint;
  pickupDate: string;
  windowStart: Date;
  windowEnd: Date;
  pickupFloor: number;
  pickupHasElevator: boolean;
  deliveryFloor: number;
  deliveryHasElevator: boolean;
};

export type ResolvedLeg = LegPlan & { distanceM: number; durationS: number };

export type PlanError =
  | "incomplete" // addresses or pickup date/window missing
  | "storage_unavailable" // no active warehouse (D72)
  | "invalid_window"
  | "return_before_pickup" // warehouse pickup date before the first pickup
  | "return_window_too_early"; // transshipment: leg 2 window starts before leg 1 window ends (D73)

export type LegsPlan = { ok: true; legs: LegPlan[]; storageDays: number | null } | { ok: false; error: PlanError };

/** Warehouse side of a leg: ground floor with an elevator (no floor surcharge). */
const AT_WAREHOUSE = { floor: 0, hasElevator: true };

export function planLegs(
  state: WizardState,
  pickup: Endpoint | null,
  delivery: Endpoint | null,
  warehouse: WarehousePoint | null,
): LegsPlan {
  if (!state.pickup || !state.delivery || !pickup || !delivery || !state.pickupDate || !state.pickupWindow) {
    return { ok: false, error: "incomplete" };
  }
  const first = windowRange(state.pickupDate, state.pickupWindow);
  if (!first) return { ok: false, error: "invalid_window" };

  if (!state.storage) {
    return {
      ok: true,
      storageDays: null,
      legs: [
        {
          pickup,
          delivery,
          pickupDate: state.pickupDate,
          windowStart: first.start,
          windowEnd: first.end,
          pickupFloor: state.pickup.floor,
          pickupHasElevator: state.pickup.hasElevator,
          deliveryFloor: state.delivery.floor,
          deliveryHasElevator: state.delivery.hasElevator,
        },
      ],
    };
  }

  if (!warehouse) return { ok: false, error: "storage_unavailable" };
  const second = windowRange(state.storage.returnDate, state.storage.returnWindow);
  if (!second) return { ok: false, error: "invalid_window" };
  const days = daysBetween(state.pickupDate, state.storage.returnDate);
  if (days < 0) return { ok: false, error: "return_before_pickup" };
  if (second.start.getTime() < first.end.getTime()) return { ok: false, error: "return_window_too_early" };

  const { id, ...point } = warehouse;
  const warehouseEndpoint: Endpoint = { ...point, warehouseId: id };
  return {
    ok: true,
    storageDays: days, // 0 = transshipment (D55, D73)
    legs: [
      {
        pickup,
        delivery: warehouseEndpoint,
        pickupDate: state.pickupDate,
        windowStart: first.start,
        windowEnd: first.end,
        pickupFloor: state.pickup.floor,
        pickupHasElevator: state.pickup.hasElevator,
        deliveryFloor: AT_WAREHOUSE.floor,
        deliveryHasElevator: AT_WAREHOUSE.hasElevator,
      },
      {
        pickup: warehouseEndpoint,
        delivery,
        pickupDate: state.storage.returnDate,
        windowStart: second.start,
        windowEnd: second.end,
        pickupFloor: AT_WAREHOUSE.floor,
        pickupHasElevator: AT_WAREHOUSE.hasElevator,
        deliveryFloor: state.delivery.floor,
        deliveryHasElevator: state.delivery.hasElevator,
      },
    ],
  };
}

/** Porters per leg (D74): pickup → leg 0; delivery → leg 1, only when the order goes through the warehouse. */
export function portersFor(state: WizardState): PorterRequest[] {
  const list: PorterRequest[] = [];
  if (state.portersPickup) list.push({ legIndex: 0, ...state.portersPickup });
  if (state.storage && state.portersDelivery) list.push({ legIndex: 1, ...state.portersDelivery });
  return list;
}

export function priceInputFor(args: {
  state: WizardState;
  legs: ResolvedLeg[];
  storageDays: number | null;
  storageBillingUnit: StorageBillingUnit;
  vehicleTypeId: string;
  customerType: "private" | "business";
  now: Date;
}): PriceInput {
  const { state, legs, storageDays, storageBillingUnit, vehicleTypeId, customerType, now } = args;
  const porters = portersFor(state);
  return {
    customerType,
    now,
    legs: legs.map((l) => ({
      distanceM: l.distanceM,
      vehicleTypeId,
      pickupAt: l.windowStart,
      pickupProvince: l.pickup.province ?? "",
      pickupFloor: l.pickupFloor,
      pickupHasElevator: l.pickupHasElevator,
      deliveryFloor: l.deliveryFloor,
      deliveryHasElevator: l.deliveryHasElevator,
    })),
    porters: porters.length ? porters : undefined,
    packing: state.packingItems > 0 ? { itemsCount: state.packingItems, legIndex: 0 } : undefined,
    storage:
      state.storage && storageDays !== null
        ? { days: storageDays, pallets: storageBillingUnit === "pallet_day" ? (state.storage.pallets ?? undefined) : undefined }
        : undefined,
  };
}
