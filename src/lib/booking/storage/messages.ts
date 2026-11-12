// Italian messages of the Deposito wizard (D158) and the step where the customer fixes each error. Pure.
import type { PricingError } from "../../pricing/types";
import { headlineCents, type PublicQuote } from "../public-quote";
import type { ChainRole } from "../../orders/order-group";

export type StorageStep =
  | "magazzino" | "tipo" | "unita" | "periodo" | "arrivo" | "uscita" | "merce" | "facchini" | "preventivo" | "account" | "contatti" | "riepilogo";

/** A transport of the chain the error belongs to (intake = "ritiro", outbound = "consegna"). */
export type TransportRole = Exclude<ChainRole, "storage">;

export type StorageError =
  | { code: "incomplete" }
  | { code: "no_warehouse" } // none picked, or the picked one is no longer active (D178)
  | { code: "invalid_period" } // end before start, start in the past, too long
  | { code: "storage_unavailable" } // no active warehouse, unit not offered by the price list
  | { code: "no_space" } // no free box / pallet places for the period (D156)
  | { code: "pricing_unavailable" }
  | { code: "maps_unavailable" }
  | { code: "transport_incomplete"; role: TransportRole }
  | { code: "invalid_window"; role: TransportRole }
  | { code: "place_not_found"; role: TransportRole }
  | { code: "not_italy"; role: TransportRole }
  | { code: "route_not_found"; role: TransportRole }
  | { code: "no_vehicle_fits"; role: TransportRole }
  | { code: "transport_pricing"; role: TransportRole; error: PricingError };

export type StorageErrorContext = { minLeadHours: number };

const WHAT: Record<TransportRole, string> = { intake: "il ritiro", outbound: "la consegna" };

export function storageErrorMessage(e: StorageError, ctx: StorageErrorContext): string {
  switch (e.code) {
    case "incomplete":
      return "Scegli il deposito e le date di inizio e fine.";
    case "no_warehouse":
      return "Scegli il magazzino.";
    case "invalid_period":
      return "Controlla le date: la fine non può essere prima dell'inizio e l'inizio non può essere nel passato.";
    case "storage_unavailable":
      return "Il deposito non è prenotabile online al momento. Contattaci per una soluzione su misura.";
    case "no_space":
      return "Non ci sono posti liberi per queste date. Prova con altre date o un'altra misura.";
    case "pricing_unavailable":
      return "Il calcolo del prezzo non è disponibile in questo momento. Riprova tra poco.";
    case "maps_unavailable":
      return "La ricerca dell'indirizzo non è disponibile in questo momento. Riprova tra poco.";
    case "transport_incomplete":
      return `Inserisci l'indirizzo e la fascia oraria per ${WHAT[e.role]}.`;
    case "invalid_window":
      return `Fascia oraria non valida per ${WHAT[e.role]}.`;
    case "place_not_found":
      return "Indirizzo non trovato. Selezionalo di nuovo dall'elenco.";
    case "not_italy":
      return "L'indirizzo deve essere in Italia.";
    case "route_not_found":
      return `Non riusciamo a calcolare il percorso per ${WHAT[e.role]}. Controlla l'indirizzo.`;
    case "no_vehicle_fits":
      return "Nessun veicolo adatto a questo carico: contattaci per un preventivo su misura.";
    case "transport_pricing":
      switch (e.error.code) {
        case "pickup_province":
          return e.role === "intake" ? "Al momento non effettuiamo ritiri in questa zona." : "Al momento non effettuiamo consegne in questa zona.";
        case "max_distance":
          return `L'indirizzo è troppo lontano dal magazzino per ${WHAT[e.role]}.`;
        case "too_soon":
          return `Per ${WHAT[e.role]} prenota almeno ${ctx.minLeadHours} ore prima della fascia oraria.`;
        case "service_unavailable":
          return e.error.service === "porters" ? "I facchini non sono disponibili al momento." : "Il servizio non è disponibile al momento.";
        default:
          return "Il calcolo del prezzo non è disponibile in questo momento. Riprova tra poco.";
      }
  }
}

export function storageErrorStep(e: StorageError): StorageStep {
  const transportStep = (role: TransportRole): StorageStep => (role === "intake" ? "arrivo" : "uscita");
  switch (e.code) {
    case "no_warehouse":
      return "magazzino";
    case "incomplete":
    case "invalid_period":
    case "no_space":
      return "periodo";
    case "storage_unavailable":
      return "unita";
    case "transport_incomplete":
    case "invalid_window":
    case "place_not_found":
    case "not_italy":
    case "route_not_found":
      return transportStep(e.role);
    case "no_vehicle_fits":
      return "merce";
    case "transport_pricing":
      if (e.error.code === "service_unavailable" && e.error.service === "porters") return "facchini";
      if (e.error.code === "too_soon") return transportStep(e.role);
      return e.error.code === "pickup_province" || e.error.code === "max_distance" ? transportStep(e.role) : "preventivo";
    default:
      return "preventivo";
  }
}

/** Out of the service area for a transport of the chain: the wizard offers the contact form (as D125). */
export const isStorageOutOfArea = (e: StorageError) =>
  e.code === "transport_pricing" && (e.error.code === "pickup_province" || e.error.code === "max_distance");

// ---------------------------------------------------------------------------
// What the browser sees of a storage quote (D29, D76): customer amounts per order of the chain, never carrier
// amounts. Totals are the sums of the parts (integers, exact — the same sums as the payment, D153).
// ---------------------------------------------------------------------------

export type PublicStoragePart = { role: ChainRole; quote: PublicQuote; distanceKm: number | null; vehicleName: string | null };

export type PublicStorageQuote = {
  customerType: "private" | "business";
  display: "gross" | "net_plus_vat";
  parts: PublicStoragePart[];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  /** The amount shown as "the price" (D3). */
  headlineCents: number;
  days: number;
};

export function toPublicStorageQuote(parts: PublicStoragePart[], days: number): PublicStorageQuote {
  if (parts.length === 0) throw new Error("storage quote without parts");
  const first = parts[0].quote;
  const sum = (k: "subtotalCents" | "vatCents" | "totalCents") => parts.reduce((s, p) => s + p.quote[k], 0);
  const totals = { subtotalCents: sum("subtotalCents"), vatCents: sum("vatCents"), totalCents: sum("totalCents") };
  return {
    customerType: first.customerType,
    display: first.display,
    parts,
    ...totals,
    headlineCents: headlineCents({ display: first.display, ...totals }),
    days,
  };
}
