// Booking wizard state (D78). This is what the browser keeps in localStorage and sends to the server:
// route, schedule, goods and services only — never contacts or billing data (personal data stays in the
// form's memory). The server always re-validates it with this schema.
import { z } from "zod";
import { PORTER_PACKAGE_CODES } from "../pricing/types";
import { isIsoDate, TIME_WINDOWS } from "./windows";

export const WIZARD_STORAGE_KEY = "transigo.booking.v1";

const dimension = z.number().int().min(1).max(2_000).nullable(); // cm

const isoDate = z.string().refine(isIsoDate, { error: "Data non valida" });

const placeChoice = z.object({
  placeId: z.string().regex(/^[A-Za-z0-9_-]{10,300}$/),
  label: z.string().trim().min(1).max(300), // suggestion text, for display only — the server resolves the place again
  floor: z.number().int().min(0).max(20),
  hasElevator: z.boolean(),
});

const porterChoice = z.object({
  packageCode: z.enum(PORTER_PACKAGE_CODES),
  count: z.number().int().min(1).max(4).optional(), // empty = persons of the package (D67)
});

export const wizardStateSchema = z.object({
  version: z.literal(1),
  /** Only used before sign-in (D3, spec 3.2); afterwards the account's type wins. */
  customerTypeView: z.enum(["private", "business"]),
  pickup: placeChoice.nullable(),
  delivery: placeChoice.nullable(),
  pickupDate: isoDate.nullable(),
  pickupWindow: z.enum(TIME_WINDOWS).nullable(),
  urgent: z.boolean(), // informative only (D49)
  goods: z.object({
    description: z.string().max(2000),
    itemsCount: z.number().int().min(1).max(10_000).nullable(),
    weightKg: z.number().int().min(1).max(50_000).nullable(), // total, indicative (D86)
    dimensionsNote: z.string().max(500),
    // D83, D86 — defaults keep states saved before these fields existed valid
    loadCategory: z.enum(PORTER_PACKAGE_CODES).nullable().default(null), // null = not a move
    largestItem: z
      .object({ lengthCm: dimension, widthCm: dimension, heightCm: dimension })
      .default({ lengthCm: null, widthCm: null, heightCm: null }),
    palletsCount: z.number().int().min(1).max(100).nullable().default(null), // EUR pallets
  }),
  /** Porters at pickup (leg 1) and — with storage only — at delivery (leg 2), D74. */
  portersPickup: porterChoice.nullable(),
  portersDelivery: porterChoice.nullable(),
  vehicleTypeId: z.uuid().nullable(),
  packingItems: z.number().int().min(0).max(500),
  storage: z
    .object({
      returnDate: isoDate, // pickup from the warehouse (D73)
      returnWindow: z.enum(TIME_WINDOWS),
      pallets: z.number().int().min(1).max(100).nullable(),
    })
    .nullable(),
});

export type WizardState = z.output<typeof wizardStateSchema>;
export type WizardStateInput = z.input<typeof wizardStateSchema>;
export type PlaceChoice = z.infer<typeof placeChoice>;
export type PorterChoice = z.infer<typeof porterChoice>;

export const EMPTY_WIZARD_STATE: WizardState = {
  version: 1,
  customerTypeView: "private",
  pickup: null,
  delivery: null,
  pickupDate: null,
  pickupWindow: null,
  urgent: false,
  goods: {
    description: "",
    itemsCount: null,
    weightKg: null,
    dimensionsNote: "",
    loadCategory: null,
    largestItem: { lengthCm: null, widthCm: null, heightCm: null },
    palletsCount: null,
  },
  portersPickup: null,
  portersDelivery: null,
  vehicleTypeId: null,
  packingItems: 0,
  storage: null,
};

/** Parses a stored state; anything invalid or from an older version is dropped. */
export function parseStoredState(raw: string | null): WizardState | null {
  if (!raw) return null;
  try {
    const parsed = wizardStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Canonical JSON of the parts that affect the price (customerTypeView and display labels excluded), so the
 * server can tell whether a stored quote still matches what the customer confirms (D76).
 */
export function priceRelevantKey(state: WizardState): string {
  const place = (p: PlaceChoice | null) => (p ? [p.placeId, p.floor, p.hasElevator] : null);
  const porters = (p: PorterChoice | null) => (p ? [p.packageCode, p.count ?? null] : null);
  return JSON.stringify([
    place(state.pickup),
    place(state.delivery),
    state.pickupDate,
    state.pickupWindow,
    porters(state.portersPickup),
    state.storage ? porters(state.portersDelivery) : null,
    state.vehicleTypeId,
    state.packingItems,
    state.storage ? [state.storage.returnDate, state.storage.returnWindow, state.storage.pallets] : null,
  ]);
}

/** What the vehicle check needs from the wizard state (D82–D86). */
export function loadNeeds(state: WizardState) {
  return {
    weightKg: state.goods.weightKg,
    largestItem: state.goods.largestItem,
    pallets: state.goods.palletsCount,
    loadCategory: state.goods.loadCategory,
  };
}
