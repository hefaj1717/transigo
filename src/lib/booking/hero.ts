// Home-page mini form (Da / A / Data) → booking wizard state (spec section 5). The form only prepares the
// wizard: it stores route and date in the wizard's localStorage state (D78 — no personal data) and the wizard
// takes over on /prenota (floors, time window, goods…). No price is computed on the home page (D76).
import { EMPTY_WIZARD_STATE, wizardStateSchema, type PlaceChoice, type WizardState } from "./state";
import { isIsoDate } from "./windows";

export type HeroInput = {
  pickup: Pick<PlaceChoice, "placeId" | "label"> | null;
  delivery: Pick<PlaceChoice, "placeId" | "label"> | null;
  /** yyyy-mm-dd or empty */
  date: string;
};

export type HeroResult = { ok: true; state: WizardState } | { ok: false; field: "pickup" | "delivery" | "date"; message: string };

/**
 * Builds a fresh wizard state from the mini form. A new search starts a new booking: everything else from a
 * previous visit is dropped, except the Privato/Azienda view. Floors default to ground floor without lift —
 * the wizard asks for them in the first step.
 */
export function heroToWizardState(input: HeroInput, today: string, previous: WizardState | null = null): HeroResult {
  if (!input.pickup) return { ok: false, field: "pickup", message: "Seleziona l'indirizzo di ritiro dall'elenco." };
  if (!input.delivery) return { ok: false, field: "delivery", message: "Seleziona l'indirizzo di consegna dall'elenco." };
  const date = input.date.trim();
  if (date && !isIsoDate(date)) return { ok: false, field: "date", message: "Data non valida." };
  if (date && date < today) return { ok: false, field: "date", message: "Scegli una data a partire da oggi." };

  const place = (p: Pick<PlaceChoice, "placeId" | "label">): PlaceChoice => ({ placeId: p.placeId, label: p.label, floor: 0, hasElevator: false });
  const candidate: WizardState = {
    ...EMPTY_WIZARD_STATE,
    customerTypeView: previous?.customerTypeView ?? EMPTY_WIZARD_STATE.customerTypeView,
    pickup: place(input.pickup),
    delivery: place(input.delivery),
    pickupDate: date || null,
  };
  // Same schema the wizard uses to restore the state: anything it would drop is refused here.
  const parsed = wizardStateSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, field: "pickup", message: "Indirizzo non valido. Selezionalo di nuovo dall'elenco." };
  return { ok: true, state: parsed.data };
}
