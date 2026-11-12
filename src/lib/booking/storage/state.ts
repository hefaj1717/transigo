// Deposito wizard state (D151, D153–D158). Like the other wizards (D78): what the browser keeps in localStorage and
// sends to the server — unit, period, how the goods arrive and leave, goods and porter choices. Never contacts or
// billing data. The server always re-validates it with this schema.
import { z } from "zod";
import { PORTER_PACKAGE_CODES } from "../../pricing/types";
import { placeChoice } from "../state";
import { addDaysIso, daysBetween, isIsoDate, TIME_WINDOWS } from "../windows";

export const STORAGE_STORAGE_KEY = "transigo.booking.deposito.v1";
export const STORAGE_WIZARD_PATH = "/prenota/deposito"; // D158

/** Longest period the wizard accepts (warehouse_free_units() refuses more than 3650 days). */
export const STORAGE_MAX_PERIOD_DAYS = 3650;
export const STORAGE_MAX_PALLETS = 100;

const isoDate = z.string().refine(isIsoDate, { error: "Data non valida" });
const dimension = z.number().int().min(1).max(2_000).nullable(); // cm

const porterChoice = z.object({
  packageCode: z.enum(PORTER_PACKAGE_CODES),
  count: z.number().int().min(1).max(4).optional(), // empty = persons of the package (D67)
});

/** A transport of the chain (D153): the customer's address, the window on the fixed day, optional porters. */
const chainTransport = z.object({
  place: placeChoice.nullable(),
  window: z.enum(TIME_WINDOWS).nullable(),
  porters: porterChoice.nullable(),
});

export const storageStateSchema = z.object({
  version: z.literal(1),
  /** Only used before sign-in (D3); afterwards the account's type wins. Boxes for private, pallets for business (D154). */
  customerTypeView: z.enum(["private", "business"]),
  boxCode: z.string().regex(/^[a-z0-9_]{1,20}$/).nullable(),
  pallets: z.number().int().min(1).max(STORAGE_MAX_PALLETS).nullable(),
  /** Inclusive period (D154): days = end − start + 1, as warehouse_bookings. */
  startDate: isoDate.nullable(),
  endDate: isoDate.nullable(),
  /** "Porto io" | "Ritiro Transigo" (transport to the warehouse on startDate). */
  intake: z.enum(["self", "transigo"]),
  /** "Ritiro io" | "Consegna Transigo" (transport from the warehouse on endDate) | "Lo deciderò più avanti" (D153). */
  outbound: z.enum(["self", "transigo", "later"]),
  intakeTransport: chainTransport,
  outboundTransport: chainTransport,
  /** What is stored; for the transports also the vehicle check (D82–D86). */
  goods: z.object({
    description: z.string().max(2000),
    itemsCount: z.number().int().min(1).max(10_000).nullable(),
    weightKg: z.number().int().min(1).max(50_000).nullable(),
    loadCategory: z.enum(PORTER_PACKAGE_CODES).nullable(),
    largestItem: z.object({ lengthCm: dimension, widthCm: dimension, heightCm: dimension }),
  }),
});

export type StorageState = z.output<typeof storageStateSchema>;
export type ChainTransportState = z.output<typeof chainTransport>;

const EMPTY_TRANSPORT: ChainTransportState = { place: null, window: null, porters: null };

export const EMPTY_STORAGE_STATE: StorageState = {
  version: 1,
  customerTypeView: "private",
  boxCode: null,
  pallets: null,
  startDate: null,
  endDate: null,
  intake: "self",
  outbound: "self",
  intakeTransport: EMPTY_TRANSPORT,
  outboundTransport: EMPTY_TRANSPORT,
  goods: { description: "", itemsCount: null, weightKg: null, loadCategory: null, largestItem: { lengthCm: null, widthCm: null, heightCm: null } },
};

export function parseStoredStorageState(raw: string | null): StorageState | null {
  if (!raw) return null;
  try {
    const parsed = storageStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Days of the inclusive period, or null when the dates are missing or reversed. */
export function storagePeriodDays(s: Pick<StorageState, "startDate" | "endDate">): number | null {
  if (!s.startDate || !s.endDate) return null;
  const days = daysBetween(s.startDate, s.endDate) + 1;
  return days >= 1 ? days : null;
}

/** End date for a number of days from the start (inclusive): 1 day = the same day. */
export const endDateFor = (startDate: string, days: number) => addDaysIso(startDate, days - 1);

/** The unit the account type books (D154): boxes for private customers, pallets for businesses. */
export const unitFor = (customerType: "private" | "business") => (customerType === "private" ? "box" : "pallet");

/**
 * Canonical JSON of what changes the price or the booking (D76): a stored quote is usable only for exactly this key.
 * The unit that does not apply to the customer type is left out (it is ignored anyway).
 */
export function storagePriceKey(s: StorageState, customerType: "private" | "business"): string {
  const t = (on: boolean, x: ChainTransportState) =>
    on ? [x.place ? [x.place.placeId, x.place.floor, x.place.hasElevator] : null, x.window, x.porters ? [x.porters.packageCode, x.porters.count ?? null] : null] : null;
  const anyTransport = s.intake === "transigo" || s.outbound === "transigo";
  return JSON.stringify([
    "storage",
    customerType,
    customerType === "private" ? s.boxCode : s.pallets,
    s.startDate,
    s.endDate,
    s.intake,
    s.outbound,
    t(s.intake === "transigo", s.intakeTransport),
    t(s.outbound === "transigo", s.outboundTransport),
    // the vehicle of the transports follows from the goods (D82–D86)
    anyTransport ? [s.goods.weightKg, s.goods.loadCategory, s.goods.largestItem.lengthCm, s.goods.largestItem.widthCm, s.goods.largestItem.heightCm] : null,
  ]);
}

/**
 * Values from the calculator link (D162: ?box=&giorni= or ?pallet=&giorni=). The query string is user-controlled:
 * only a box code of the active price list and integers in range are taken; anything else is ignored.
 */
export type StoragePrefill = { boxCode?: string; pallets?: number; days?: number };

export function parseStoragePrefill(sp: Record<string, string | string[] | undefined>, boxCodes: readonly string[]): StoragePrefill {
  const int = (key: string, min: number, max: number) => {
    const raw = sp[key];
    if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw)) return undefined;
    const n = Number(raw);
    return n >= min && n <= max ? n : undefined;
  };
  const box = sp.box;
  return {
    boxCode: typeof box === "string" && boxCodes.includes(box) ? box : undefined,
    pallets: int("pallet", 1, STORAGE_MAX_PALLETS),
    days: int("giorni", 1, STORAGE_MAX_PERIOD_DAYS),
  };
}
