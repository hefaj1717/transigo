// What a carrier still has to complete before activation (shown on "Account in attesa di verifica").
// Pure function; the page loads the data. Items marked comingSoon are built in Stage 4.
import type { CarrierStatus } from "./routing";

export type CarrierOnboardingInput = {
  status: CarrierStatus | null;
  statusReason: string | null;
  company: {
    company_name: string | null;
    vat_number: string | null;
    fiscal_code: string | null;
    hq_street: string | null;
    hq_city: string | null;
    hq_postal_code: string | null;
    hq_province: string | null;
    pec: string | null;
    sdi_code: string | null;
  } | null;
  phoneVerified: boolean;
  documentsCount: number;
  activeVehiclesCount: number;
  stripePayoutsEnabled: boolean;
};

export type ChecklistItem = {
  key: "company" | "phone" | "documents" | "vehicle" | "payouts" | "approval";
  label: string;
  done: boolean;
  comingSoon: boolean;
};

export type CarrierOnboarding = {
  /** Status-specific notice under the heading (null for pending_review). */
  notice: string | null;
  items: ChecklistItem[];
};

function companyComplete(c: CarrierOnboardingInput["company"]): boolean {
  if (!c) return false;
  const required = [c.company_name, c.vat_number, c.fiscal_code, c.hq_street, c.hq_city, c.hq_postal_code, c.hq_province];
  return required.every((v) => !!v?.trim()) && !!(c.pec?.trim() || c.sdi_code?.trim());
}

export function carrierOnboarding(input: CarrierOnboardingInput): CarrierOnboarding {
  const reason = input.statusReason?.trim();
  let notice: string | null = null;
  if (input.status === "rejected") {
    notice = `La tua registrazione non è stata approvata${reason ? `: ${reason}` : "."} Contattaci per maggiori informazioni.`;
  } else if (input.status === "suspended") {
    notice = `Il tuo account è stato sospeso${reason ? `: ${reason}` : "."} Contattaci per maggiori informazioni.`;
  }

  return {
    notice,
    items: [
      { key: "company", label: "Dati aziendali", done: companyComplete(input.company), comingSoon: false },
      { key: "phone", label: "Verifica del numero di telefono", done: input.phoneVerified, comingSoon: true },
      {
        key: "documents",
        label: "Documenti (licenza, assicurazione, libretto, documento d'identità, patente)",
        done: input.documentsCount > 0,
        comingSoon: true,
      },
      { key: "vehicle", label: "Veicolo", done: input.activeVehiclesCount > 0, comingSoon: true },
      { key: "payouts", label: "Conto per ricevere i pagamenti (Stripe)", done: input.stripePayoutsEnabled, comingSoon: true },
      { key: "approval", label: "Verifica dell'account da parte di Transigo", done: input.status === "active", comingSoon: false },
    ],
  };
}
