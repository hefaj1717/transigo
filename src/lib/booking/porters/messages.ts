// Italian messages of the Facchinaggio wizard (D158) and the step where the customer fixes each error.
import { applyBp } from "../../pricing/money";
import type { PortersJobTerms } from "../../pricing/porters-service";
import type { PricingError } from "../../pricing/types";

export type PortersStep =
  | "indirizzo" | "data" | "cosa" | "preventivo" | "account" | "contatti" | "riepilogo";

export type PortersError =
  | PricingError
  | { code: "incomplete" }
  | { code: "invalid_window" }
  | { code: "place_not_found" }
  | { code: "not_italy" }
  | { code: "maps_unavailable" }
  | { code: "pricing_unavailable" };

export type PortersErrorContext = { minLeadHours: number; minPersons: number; minHours: number };

export function portersErrorMessage(e: PortersError, ctx: PortersErrorContext): string {
  switch (e.code) {
    case "pickup_province":
      return "Al momento non offriamo il facchinaggio in questa zona.";
    case "too_soon":
      return `Prenota almeno ${ctx.minLeadHours} ore prima dell'inizio del lavoro.`;
    case "service_unavailable":
      return "Il servizio di facchinaggio non è disponibile al momento.";
    case "invalid_input":
      return `Controlla i dati: servono almeno ${ctx.minPersons === 1 ? "1 facchino" : `${ctx.minPersons} facchini`} e ${ctx.minHours} ${ctx.minHours === 1 ? "ora" : "ore"}.`;
    case "incomplete":
      return "Inserisci l'indirizzo, la data e la fascia oraria.";
    case "invalid_window":
      return "Data o fascia oraria non valida.";
    case "place_not_found":
      return "Indirizzo non trovato. Selezionalo di nuovo dall'elenco.";
    case "not_italy":
      return "L'indirizzo deve essere in Italia.";
    case "maps_unavailable":
      return "La ricerca dell'indirizzo non è disponibile in questo momento. Riprova tra poco.";
    case "pricing_unavailable":
    case "max_distance": // never for porters (no route); kept exhaustive
    case "vehicle_not_priced":
      return "Il calcolo del prezzo non è disponibile in questo momento. Riprova tra poco.";
  }
}

export function portersErrorStep(e: PortersError): PortersStep {
  switch (e.code) {
    case "pickup_province":
    case "place_not_found":
    case "not_italy":
    case "maps_unavailable":
    case "incomplete":
      return "indirizzo";
    case "too_soon":
    case "invalid_window":
      return "data";
    case "invalid_input":
      return "data"; // team and hours are in the date step
    default:
      return "preventivo";
  }
}

/** Out-of-area: the wizard offers the contact form, as the transport wizard (D125). */
export const isPortersOutOfArea = (e: PortersError) => e.code === "pickup_province";

/** What the browser may see of the job terms (D29): team, hours and the overtime rate (net and gross, D3, D68). */
export type PublicPortersJob = {
  persons: number;
  includedHours: number;
  overtimeRateNetCents: number | null;
  overtimeRateGrossCents: number | null;
  overtimeGraceMinutes: number;
};

export function toPublicPortersJob(job: PortersJobTerms, vatRateBp: number): PublicPortersJob {
  const rate = job.overtimeRatePerPersonCents;
  return {
    persons: job.persons,
    includedHours: job.includedHours,
    overtimeRateNetCents: rate,
    // Display only; the overtime invoice computes VAT on its own total (D56).
    overtimeRateGrossCents: rate === null ? null : rate + applyBp(rate, vatRateBp),
    overtimeGraceMinutes: job.overtimeGraceMinutes,
  };
}
