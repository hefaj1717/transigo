// Facchinaggio wizard state (D151, D158). Like the transport wizard (D78): what the browser keeps in localStorage
// and sends to the server — address choice, date, team and the description only, never contacts or billing.
// The server always re-validates it with this schema.
import { z } from "zod";
import { PORTERS_MAX_HOURS, PORTERS_MAX_PERSONS } from "../../pricing/porters-service";
import { placeChoice } from "../state";
import { isIsoDate, TIME_WINDOWS } from "../windows";

export const PORTERS_STORAGE_KEY = "transigo.booking.facchini.v1";
export const PORTERS_WIZARD_PATH = "/prenota/facchini"; // D158

/** Lower bounds of the form; the price list may ask for more (porters_min_persons / porters_min_hours, D157). */
export const PORTERS_FORM_MIN_PERSONS = 2;

export const portersStateSchema = z.object({
  version: z.literal(1),
  /** Only used before sign-in (D3); afterwards the account's type wins. */
  customerTypeView: z.enum(["private", "business"]),
  place: placeChoice.nullable(), // floor 0–20 = PORTERS_MAX_FLOOR (D53)
  date: z.string().refine(isIsoDate, { error: "Data non valida" }).nullable(),
  window: z.enum(TIME_WINDOWS).nullable(),
  persons: z.number().int().min(PORTERS_FORM_MIN_PERSONS).max(PORTERS_MAX_PERSONS),
  hours: z.number().int().min(1).max(PORTERS_MAX_HOURS),
  /** "Cosa spostare" — goods_description of the order; not price-relevant. */
  description: z.string().max(2000),
});

export type PortersState = z.output<typeof portersStateSchema>;

export const EMPTY_PORTERS_STATE: PortersState = {
  version: 1,
  customerTypeView: "private",
  place: null,
  date: null,
  window: null,
  persons: 2,
  hours: 2,
  description: "",
};

export function parseStoredPortersState(raw: string | null): PortersState | null {
  if (!raw) return null;
  try {
    const parsed = portersStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Canonical JSON of what changes the price (D76): a stored quote is usable only for exactly this key. */
export function portersPriceKey(s: PortersState): string {
  return JSON.stringify(["porters", s.place ? [s.place.placeId, s.place.floor, s.place.hasElevator] : null, s.date, s.window, s.persons, s.hours]);
}

/**
 * Values from the calculator link (D162: ?persone=&ore=&piano=&ascensore=). The query string is user-controlled:
 * only integers in range are taken, anything else is ignored. Floor and elevator wait for the address choice.
 */
export type PortersPrefill = { persons?: number; hours?: number; floor?: number; hasElevator?: boolean };

export function parsePortersPrefill(sp: Record<string, string | string[] | undefined>, minPersons: number): PortersPrefill {
  const int = (key: string, min: number, max: number) => {
    const raw = sp[key];
    if (typeof raw !== "string" || !/^\d{1,2}$/.test(raw)) return undefined;
    const n = Number(raw);
    return n >= min && n <= max ? n : undefined;
  };
  const lift = sp.ascensore;
  return {
    persons: int("persone", Math.max(minPersons, PORTERS_FORM_MIN_PERSONS), PORTERS_MAX_PERSONS),
    hours: int("ore", 1, PORTERS_MAX_HOURS),
    floor: int("piano", 0, 20),
    hasElevator: lift === "1" ? true : lift === "0" ? false : undefined,
  };
}
