// Carrier onboarding (Stage 4.1, D99–D101, D108, D109). Pure: pages load the data and call these functions.
import type { CarrierStatus } from "@/lib/auth/routing";
import { documentTypeConfig, CARRIER_DOCUMENT_TYPES, type CarrierDocumentType } from "./document-types";

export const CARRIER_PATHS = {
  home: "/padroncino",
  company: "/padroncino/dati-aziendali",
  vehicles: "/padroncino/veicoli",
  newVehicle: "/padroncino/veicoli/nuovo",
  vehicle: (id: string) => `/padroncino/veicoli/${id}`,
  documents: "/padroncino/documenti",
} as const;

// ---------------------------------------------------------------------------
// Which screen the carrier sees
// ---------------------------------------------------------------------------

/**
 * incomplete — registration not sent yet (pending_review, submitted_at null): editing allowed
 * in_review  — sent, waiting for the admin (pending_review + submitted_at): read only (D100, D109)
 * rejected   — the admin rejected it (submitted_at cleared): editing allowed, can be sent again
 * suspended / active — outside onboarding
 * missing    — no carriers row (should not happen: registration creates it)
 */
export type CarrierOnboardingView = "incomplete" | "in_review" | "rejected" | "suspended" | "active" | "missing";

export function carrierOnboardingView(status: CarrierStatus | null, submittedAt: string | null): CarrierOnboardingView {
  switch (status) {
    case "pending_review":
      return submittedAt ? "in_review" : "incomplete";
    case "rejected":
      return "rejected";
    case "suspended":
      return "suspended";
    case "active":
      return "active";
    default:
      return "missing";
  }
}

/** Company data, vehicles and documents can be changed (and the account sent) only in these views. */
export function canEditOnboarding(view: CarrierOnboardingView): boolean {
  return view === "incomplete" || view === "rejected";
}

// ---------------------------------------------------------------------------
// What is missing (codes from carrier_onboarding_missing(), D99)
// ---------------------------------------------------------------------------

export type MissingCode =
  | { kind: "company" }
  | { kind: "vehicle" }
  | { kind: "document"; docType: CarrierDocumentType }
  | { kind: "vehicle_document"; vehicleId: string; docType: CarrierDocumentType }
  | { kind: "unknown"; code: string };

const KNOWN_TYPES = new Set<string>(CARRIER_DOCUMENT_TYPES.map((t) => t.docType));
const isDocType = (v: string): v is CarrierDocumentType => KNOWN_TYPES.has(v);

export function parseMissingCode(code: string): MissingCode {
  if (code === "company" || code === "vehicle") return { kind: code };
  const parts = code.split(":");
  if (parts.length === 2 && parts[0] === "document" && isDocType(parts[1])) {
    return { kind: "document", docType: parts[1] };
  }
  if (parts.length === 3 && parts[0] === "vehicle_document" && parts[1] && isDocType(parts[2])) {
    return { kind: "vehicle_document", vehicleId: parts[1], docType: parts[2] };
  }
  return { kind: "unknown", code };
}

export type MissingItem = { code: string; label: string; href: string };

/** Missing codes → Italian labels with a link to the screen where the carrier fixes them. */
export function describeMissing(codes: readonly string[], vehicles: readonly { id: string; plate: string }[]): MissingItem[] {
  return codes.map((code) => {
    const m = parseMissingCode(code);
    switch (m.kind) {
      case "company":
        return { code, label: "Completa i dati aziendali", href: CARRIER_PATHS.company };
      case "vehicle":
        return { code, label: "Aggiungi almeno un veicolo", href: CARRIER_PATHS.newVehicle };
      case "document":
        return { code, label: `Carica: ${documentTypeConfig(m.docType).labelIt}`, href: `${CARRIER_PATHS.documents}#${m.docType}` };
      case "vehicle_document": {
        const plate = vehicles.find((v) => v.id === m.vehicleId)?.plate;
        const label = `Carica: ${documentTypeConfig(m.docType).labelIt}${plate ? ` (veicolo ${plate})` : ""}`;
        return { code, label, href: `${CARRIER_PATHS.vehicle(m.vehicleId)}#${m.docType}` };
      }
      default:
        return { code, label: "Completa la registrazione", href: CARRIER_PATHS.home };
    }
  });
}

// ---------------------------------------------------------------------------
// Checklist on the carrier home screen
// ---------------------------------------------------------------------------

export type ChecklistItem = {
  key: "company" | "vehicle" | "documents" | "phone" | "payouts" | "approval";
  label: string;
  href: string | null;
  done: boolean;
  /** Built in a later step; does not block sending for review (D108). */
  comingSoon: boolean;
};

export type CarrierOnboardingInput = {
  view: CarrierOnboardingView;
  /** Result of carrier_onboarding_missing(). */
  missing: readonly string[];
  statusReason: string | null;
  submittedAt: string | null;
  phoneVerified: boolean;
  stripePayoutsEnabled: boolean;
};

export type CarrierOnboarding = {
  /** Status-specific notice under the heading. */
  notice: string | null;
  items: ChecklistItem[];
  /** "Invia per la verifica" is enabled. */
  canSubmit: boolean;
};

const romeDateTime = (iso: string) =>
  new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

function onboardingNotice(input: CarrierOnboardingInput): string | null {
  const reason = input.statusReason?.trim();
  switch (input.view) {
    case "rejected":
      return `La tua registrazione non è stata approvata${reason ? `: ${reason}` : "."} Correggi i dati e inviali di nuovo per la verifica.`;
    case "suspended":
      return `Il tuo account è stato sospeso${reason ? `: ${reason}` : "."} Contattaci per maggiori informazioni.`;
    case "in_review":
      return `Abbiamo ricevuto i tuoi dati${input.submittedAt ? ` il ${romeDateTime(input.submittedAt)}` : ""}. Il team Transigo li sta verificando: ti avviseremo via e-mail.`;
    default:
      return null;
  }
}

export function carrierOnboarding(input: CarrierOnboardingInput): CarrierOnboarding {
  const parsed = input.missing.map(parseMissingCode);
  const editable = canEditOnboarding(input.view);
  const companyDone = !parsed.some((m) => m.kind === "company");
  const vehicleDone = !parsed.some((m) => m.kind === "vehicle" || m.kind === "vehicle_document");
  const documentsDone = !parsed.some((m) => m.kind === "document");

  return {
    notice: onboardingNotice(input),
    canSubmit: editable && input.missing.length === 0,
    items: [
      { key: "company", label: "Dati aziendali", href: CARRIER_PATHS.company, done: companyDone, comingSoon: false },
      { key: "vehicle", label: "Veicoli e relativi documenti (libretto, RCA)", href: CARRIER_PATHS.vehicles, done: vehicleDone, comingSoon: false },
      { key: "documents", label: "Documenti aziendali (Albo, patente)", href: CARRIER_PATHS.documents, done: documentsDone, comingSoon: false },
      { key: "phone", label: "Verifica del numero di telefono", href: null, done: input.phoneVerified, comingSoon: true },
      { key: "payouts", label: "Conto per ricevere i pagamenti (Stripe)", href: null, done: input.stripePayoutsEnabled, comingSoon: true },
      { key: "approval", label: "Verifica dell'account da parte di Transigo", href: null, done: input.view === "active", comingSoon: false },
    ],
  };
}

// ---------------------------------------------------------------------------
// Errors of onboarding Server Actions
// ---------------------------------------------------------------------------

export const ONBOARDING_MSG = {
  inReview: "Il tuo account è in verifica: non puoi modificare i dati finché il team Transigo non avrà deciso.",
  notEditable: "In questo stato dell'account non puoi modificare i dati. Contatta l'assistenza Transigo.",
  suspendedVehicles: "Con l'account sospeso non puoi modificare i veicoli. Puoi caricare documenti aggiornati.",
  companyLocked: "I dati aziendali non si possono più modificare. Per correggerli contatta l'assistenza Transigo.",
  incomplete: "Mancano ancora alcuni dati: completa i passaggi indicati e riprova.",
  generic: "Si è verificato un errore. Riprova più tardi.",
} as const;

/**
 * Vehicles (D112): editable during onboarding and also when the account is active (a new vehicle, a change of
 * type or payload — D107 then sends it back to the admin). Blocked while in review (D109) and when suspended.
 */
export function canEditVehicles(view: CarrierOnboardingView): boolean {
  return canEditOnboarding(view) || view === "active";
}

/** Why a vehicle change is refused in this view (null = allowed). */
export function vehicleEditBlock(view: CarrierOnboardingView): string | null {
  if (canEditVehicles(view)) return null;
  if (view === "in_review") return ONBOARDING_MSG.inReview;
  return view === "suspended" ? ONBOARDING_MSG.suspendedVehicles : ONBOARDING_MSG.notEditable;
}

/**
 * Documents (D112): as vehicles, plus a suspended account — uploading renewed documents (e.g. an expired RCA)
 * is its only way back. An upload changes nothing else: the account returns to active only by an admin decision.
 */
export function canUploadDocuments(view: CarrierOnboardingView): boolean {
  return canEditVehicles(view) || view === "suspended";
}

/** Why a document upload is refused in this view (null = allowed). */
export function documentEditBlock(view: CarrierOnboardingView): string | null {
  if (canUploadDocuments(view)) return null;
  return view === "in_review" ? ONBOARDING_MSG.inReview : ONBOARDING_MSG.notEditable;
}

/** Why a change is refused in this view (null = allowed). */
export function onboardingEditBlock(view: CarrierOnboardingView): string | null {
  if (canEditOnboarding(view)) return null;
  return view === "in_review" ? ONBOARDING_MSG.inReview : ONBOARDING_MSG.notEditable;
}

type DbError = { code?: string | null; message?: string | null; details?: string | null } | null | undefined;

/** Missing codes from the 23514 "incomplete" error of submit_carrier_for_review() (detail = comma-separated codes). */
export function incompleteCodes(error: DbError): string[] | null {
  if (error?.code !== "23514" || !(error.message ?? "").includes("incomplete")) return null;
  return (error.details ?? "").split(",").map((c) => c.trim()).filter(Boolean);
}
