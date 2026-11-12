// Italian messages for booking errors (UI language) and the wizard step each error belongs to.
import type { PricingError } from "../pricing/types";
import type { PlanError } from "./build";

export type BookingStep = "percorso" | "data" | "merce" | "veicolo" | "preventivo" | "account" | "contatti" | "riepilogo";

export type BookingError =
  | PricingError
  | { code: PlanError }
  | { code: "place_not_found"; which: "pickup" | "delivery" }
  | { code: "not_italy"; which: "pickup" | "delivery" }
  | { code: "route_not_found"; legIndex: number }
  | { code: "maps_unavailable" }
  | { code: "pricing_unavailable" };

export type BookingErrorContext = { maxDistanceKm: number; minLeadHours: number };

const which = (w: "pickup" | "delivery") => (w === "pickup" ? "di ritiro" : "di consegna");

export function bookingErrorMessage(e: BookingError, ctx: BookingErrorContext): string {
  switch (e.code) {
    case "pickup_province":
      return e.legIndex === 0
        ? "Al momento non serviamo questa zona: il ritiro deve essere in una provincia servita."
        : "Al momento il deposito non è disponibile per questa zona.";
    case "max_distance":
      return `Il percorso supera la distanza massima di ${ctx.maxDistanceKm} km.`;
    case "too_soon":
      return `Prenota almeno ${ctx.minLeadHours} ore prima del ritiro.`;
    case "vehicle_not_priced":
      return "Questo veicolo non è disponibile al momento. Scegline un altro.";
    case "service_unavailable":
      return {
        porters: "Il servizio di facchinaggio non è disponibile al momento.",
        packing: "Il servizio di imballaggio non è disponibile al momento.",
        storage: "Il servizio di deposito non è disponibile al momento.",
      }[e.service];
    case "invalid_input":
      return "Alcuni dati non sono validi. Controlla i campi e riprova.";
    case "incomplete":
      return "Inserisci gli indirizzi, la data e la fascia oraria del ritiro.";
    case "storage_unavailable":
      return "Il servizio di deposito non è disponibile al momento.";
    case "invalid_window":
      return "Data o fascia oraria non valida.";
    case "return_before_pickup":
      return "La data di ritiro dal deposito non può essere precedente al ritiro.";
    case "return_window_too_early":
      return "Nello stesso giorno, la fascia di ritiro dal deposito deve iniziare dopo la fine della fascia di ritiro.";
    case "storage_too_long":
      return "Per ora il deposito è disponibile solo per un periodo breve: scegli una data di ritiro dal deposito più vicina.";
    case "place_not_found":
      return `Indirizzo ${which(e.which)} non trovato. Selezionalo di nuovo dall'elenco.`;
    case "not_italy":
      return `L'indirizzo ${which(e.which)} deve essere in Italia.`;
    case "route_not_found":
      return "Non riusciamo a calcolare il percorso stradale tra questi indirizzi.";
    case "maps_unavailable":
      return "Il calcolo del percorso non è disponibile in questo momento. Riprova tra poco.";
    case "pricing_unavailable":
      return "Il calcolo del prezzo non è disponibile in questo momento. Riprova tra poco.";
  }
}

/** The step where the customer can fix the error. */
export function bookingErrorStep(e: BookingError): BookingStep {
  switch (e.code) {
    case "pickup_province":
    case "max_distance":
    case "place_not_found":
    case "not_italy":
    case "route_not_found":
    case "maps_unavailable":
      return "percorso";
    case "too_soon":
    case "invalid_window":
      return "data";
    case "incomplete":
      return "percorso";
    case "vehicle_not_priced":
      return "veicolo";
    case "service_unavailable":
      return e.service === "porters" ? "percorso" : "preventivo";
    // Storage and packing are no longer offered in the transport wizard (Deposito has its own wizard, D153).
    case "storage_unavailable":
    case "return_before_pickup":
    case "return_window_too_early":
    case "storage_too_long":
      return "preventivo";
    case "invalid_input":
    case "pricing_unavailable":
      return "preventivo";
  }
}

/**
 * The quote failed because the route is outside the service area (spec 2a): pickup province not served
 * (first leg — the warehouse leg has its own message) or route too long. The wizard then offers the
 * "out of area" contact form (D125).
 */
export function isOutOfArea(e: BookingError): boolean {
  return (e.code === "pickup_province" && e.legIndex === 0) || e.code === "max_distance";
}
