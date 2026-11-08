// Types shared by the wizard's client components (no server code here).
import type { BookingError, BookingStep } from "@/lib/booking/messages";
import type { PublicPorterTerms, PublicQuote } from "@/lib/booking/public-quote";
import type { VehicleCheck } from "@/lib/booking/server";

export type WizardSession =
  | { kind: "anonymous" }
  | { kind: "customer"; customerType: "private" | "business"; firstName: string | null }
  | { kind: "incomplete" } // D80
  | { kind: "other_role" }
  | { kind: "blocked" };

export type VehiclePriceView = { vehicleTypeId: string; headlineCents: number } | { vehicleTypeId: string; error: BookingError };

/** JSON returned by POST /api/booking/quote. */
export type QuoteResponse =
  | {
      ok: true;
      customerType: "private" | "business";
      distancesKm: number[];
      vehicles: VehiclePriceView[];
      fit: VehicleCheck;
      porters: PublicPorterTerms[];
      selected: { quoteId: string; validUntil: string; quote: PublicQuote } | null;
    }
  | { ok: false; customerType?: "private" | "business"; error: BookingError; message: string; step: BookingStep };

export const STEPS: { id: BookingStep; label: string }[] = [
  { id: "percorso", label: "Percorso" },
  { id: "data", label: "Data e ora" },
  { id: "merce", label: "Merce e facchinaggio" },
  { id: "veicolo", label: "Veicolo" },
  { id: "servizi", label: "Servizi extra" },
  { id: "preventivo", label: "Preventivo" },
  { id: "account", label: "Account" },
  { id: "contatti", label: "Contatti" },
  { id: "riepilogo", label: "Riepilogo" },
];

export const stepIndex = (id: BookingStep) => STEPS.findIndex((s) => s.id === id);
