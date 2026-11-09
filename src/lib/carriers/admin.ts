// Admin screens for carriers (/admin/padroncini, D101, D113–D116). Pure: pages and server code call these.
import { z } from "zod";
import type { CarrierStatus } from "@/lib/auth/routing";
import { documentTypeConfig } from "./document-types";
import { parseMissingCode } from "./onboarding";

export const ADMIN_CARRIER_PATHS = {
  list: "/admin/padroncini",
  tab: (tab: AdminCarrierTab) => `/admin/padroncini?tab=${tab}`,
  detail: (id: string) => `/admin/padroncini/${id}`,
} as const;

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type AdminCarrierTab =
  | "da-verificare"
  | "incompleti"
  | "attivi"
  | "sospesi"
  | "rifiutati"
  | "veicoli"
  | "documenti";

export const ADMIN_CARRIER_TABS: readonly { key: AdminCarrierTab; label: string }[] = [
  { key: "da-verificare", label: "Da verificare" },
  { key: "veicoli", label: "Veicoli da verificare" },
  { key: "documenti", label: "Documenti da verificare" },
  { key: "incompleti", label: "Registrazione incompleta" },
  { key: "attivi", label: "Attivi" },
  { key: "sospesi", label: "Sospesi" },
  { key: "rifiutati", label: "Rifiutati" },
];

export function parseAdminCarrierTab(value: unknown): AdminCarrierTab {
  return ADMIN_CARRIER_TABS.find((t) => t.key === value)?.key ?? "da-verificare";
}

/** Carrier account tab from the carriers row (D100: pending_review without submitted_at = not sent yet). */
export function carrierAccountTab(status: CarrierStatus, submittedAt: string | null): AdminCarrierTab {
  switch (status) {
    case "pending_review":
      return submittedAt ? "da-verificare" : "incompleti";
    case "active":
      return "attivi";
    case "suspended":
      return "sospesi";
    case "rejected":
      return "rifiutati";
  }
}

export const CARRIER_STATUS_LABEL: Record<AdminCarrierTab, string> = {
  "da-verificare": "In verifica",
  incompleti: "Registrazione incompleta",
  attivi: "Attivo",
  sospesi: "Sospeso",
  rifiutati: "Rifiutato",
  veicoli: "",
  documenti: "",
};

/** Single document / vehicle review applies only to these carriers (D113, D114). */
export const canReviewSingly = (status: CarrierStatus) => status === "active" || status === "suspended";

// ---------------------------------------------------------------------------
// Jobs in progress (D116): a suspended carrier keeps the jobs it accepted — the admin is warned.
// ---------------------------------------------------------------------------

export const ACTIVE_JOB_STATUSES = ["assigned", "picked_up", "in_transit"] as const;

// ---------------------------------------------------------------------------
// Missing items, as the admin reads them (no links to carrier screens)
// ---------------------------------------------------------------------------

export function describeMissingForAdmin(codes: readonly string[], vehicles: readonly { id: string; plate: string }[]): string[] {
  return codes.map((code) => {
    const m = parseMissingCode(code);
    switch (m.kind) {
      case "company":
        return "Dati aziendali incompleti";
      case "vehicle":
        return "Nessun veicolo attivo";
      case "document":
        return documentTypeConfig(m.docType).labelIt;
      case "vehicle_document": {
        const plate = vehicles.find((v) => v.id === m.vehicleId)?.plate ?? "veicolo";
        return `${documentTypeConfig(m.docType).labelIt} (${plate})`;
      }
      default:
        return code;
    }
  });
}

// ---------------------------------------------------------------------------
// Form input
// ---------------------------------------------------------------------------

export const REASON_MAX = 1000;

export const ADMIN_CARRIER_MSG = {
  reasonRequired: "Indica il motivo (massimo 1000 caratteri).",
  notAwaitingReview: "Questo padroncino non è più in attesa di verifica (forse è già stato deciso). Ricarica la pagina.",
  incomplete: "La registrazione non è completa:",
  notActiveOrSuspended: "Operazione possibile solo per padroncini attivi o sospesi.",
  alreadyReviewed: "Il documento è già stato valutato. Ricarica la pagina.",
  vehicleNotPending: "Il veicolo è già approvato o non è attivo. Ricarica la pagina.",
  vehicleDocumentsMissing: "Il veicolo non ha tutti i documenti obbligatori validi:",
  notActive: "Si può sospendere solo un padroncino attivo. Ricarica la pagina.",
  notSuspended: "Si può riattivare solo un padroncino sospeso. Ricarica la pagina.",
  pendingDocuments: "Prima di riattivare valuta i documenti in attesa di verifica.",
  notFound: "Elemento non trovato.",
  vatTaken: "Questa partita IVA è già registrata da un altro padroncino.",
  forbidden: "Operazione non consentita.",
  generic: "Operazione non riuscita. Riprova.",
} as const;

const uuid = z.uuid();

/** Required reason: trimmed, 1–1000 characters. */
export const reasonSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, { error: ADMIN_CARRIER_MSG.reasonRequired }).max(REASON_MAX, { error: ADMIN_CARRIER_MSG.reasonRequired }));

export const decisionSchema = z.discriminatedUnion("decision", [
  z.object({ id: uuid, decision: z.literal("approve") }),
  z.object({ id: uuid, decision: z.literal("reject"), reason: reasonSchema }),
]);

export const suspensionSchema = z.discriminatedUnion("decision", [
  z.object({ id: uuid, decision: z.literal("suspend"), reason: reasonSchema }),
  z.object({ id: uuid, decision: z.literal("reactivate") }),
]);

export const idSchema = z.object({ id: uuid });

/** FormData → plain object of strings (files ignored). */
export function formValues(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Database errors → Italian messages
// ---------------------------------------------------------------------------

type DbError = { code?: string | null; message?: string | null; details?: string | null } | null | undefined;

export type AdminDbErrorContext = "decide" | "document" | "vehicle" | "suspend" | "reactivate";

/** Maps errors of decide_carrier_review / review_carrier_document / approve_carrier_vehicle / set_carrier_suspension. */
export function adminCarrierDbError(error: DbError, context: AdminDbErrorContext, vehicles: readonly { id: string; plate: string }[] = []): string {
  const msg = error?.message ?? "";
  const missing = () => describeMissingForAdmin((error?.details ?? "").split(",").map((c) => c.trim()).filter(Boolean), vehicles).join(", ");
  switch (error?.code) {
    case "42501":
      return ADMIN_CARRIER_MSG.forbidden;
    case "22023":
      if (/not found/.test(msg)) return ADMIN_CARRIER_MSG.notFound;
      if (/reason/.test(msg)) return ADMIN_CARRIER_MSG.reasonRequired;
      return ADMIN_CARRIER_MSG.generic;
    case "23514":
      if (/incomplete/.test(msg)) return `${ADMIN_CARRIER_MSG.incomplete} ${missing()}.`;
      if (/documents missing/.test(msg)) return `${ADMIN_CARRIER_MSG.vehicleDocumentsMissing} ${missing()}.`;
      return ADMIN_CARRIER_MSG.generic;
    case "55000":
      if (/not active or suspended/.test(msg)) return ADMIN_CARRIER_MSG.notActiveOrSuspended;
      switch (context) {
        case "decide":
          return ADMIN_CARRIER_MSG.notAwaitingReview;
        case "document":
          return ADMIN_CARRIER_MSG.alreadyReviewed;
        case "vehicle":
          return ADMIN_CARRIER_MSG.vehicleNotPending;
        case "suspend":
          return ADMIN_CARRIER_MSG.notActive;
        case "reactivate":
          return error.details === "pending_documents" ? ADMIN_CARRIER_MSG.pendingDocuments : ADMIN_CARRIER_MSG.notSuspended;
      }
  }
  return ADMIN_CARRIER_MSG.generic;
}
