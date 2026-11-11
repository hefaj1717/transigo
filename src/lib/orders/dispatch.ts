// Admin dispatch, minimal version (D122, D123). Pure: pages, server code and tests use these.
import { z } from "zod";

export const ADMIN_ORDER_PATHS = {
  list: "/admin/ordini",
  detail: (id: string) => `/admin/ordini/${id}`,
} as const;

/** One step forward (admin_advance_order). */
export const NEXT_STATUS: Partial<Record<string, { to: "picked_up" | "in_transit" | "delivered"; label: string }>> = {
  assigned: { to: "picked_up", label: "Segna come ritirato" },
  picked_up: { to: "in_transit", label: "Segna come in viaggio" },
  in_transit: { to: "delivered", label: "Segna come consegnato" },
};

/** Reason codes of "Rimuovi padroncino" (written only to the audit log, D122). */
export const UNASSIGN_REASONS = [
  { code: "errore_admin", label: "Errore nell'assegnazione" },
  { code: "richiesta_padroncino", label: "Richiesta del padroncino" },
  { code: "problema_veicolo", label: "Problema al veicolo" },
  { code: "padroncino_non_disponibile", label: "Padroncino non disponibile" },
  { code: "altro", label: "Altro" },
] as const;
export type UnassignReason = (typeof UNASSIGN_REASONS)[number]["code"];

export const DISPATCH_MSG = {
  assigned: "Padroncino assegnato.",
  unassigned: "Padroncino rimosso: l'ordine è di nuovo da assegnare.",
  advanced: (label: string) => `Stato aggiornato: ${label}.`,
  deliveredWithoutPod: "Consegna registrata senza firma e foto: il pagamento al padroncino non partirà in automatico.",
  chooseCandidate: "Scegli un padroncino e un veicolo.",
  chooseReason: "Scegli il motivo.",
  handoverAssigned: "Padroncino assegnato: vedrà l'indirizzo dove ritirare la merce.",
  addressRequired: "Scrivi dove si trova ora la merce (massimo 500 caratteri).",
  handoverReasonRequired: "Scrivi il motivo (massimo 1000 caratteri).",
  notHandover: "L'ordine non è più «da gestire». Ricarica la pagina.",
  noteRequired: "Scrivi il motivo della consegna senza firma e foto (massimo 1000 caratteri).",
  alreadyTaken: "L'ordine è già stato assegnato (forse da un padroncino dall'app). Ricarica la pagina.",
  notAvailable: "L'ordine non è più da assegnare. Ricarica la pagina.",
  tooLate: "La finestra di ritiro è già iniziata: non si può assegnare.",
  carrierNotEligible: "Il padroncino non può ricevere corse (account non attivo o documenti non approvati/scaduti).",
  vehicleNotReady: "Il veicolo non è pronto (non approvato o documenti non approvati/scaduti).",
  vehicleNotSuitable: "Il veicolo non è adatto a questo ordine (tipo, portata, misure o pallet).",
  notAssigned: "L'ordine non è più assegnato (forse già ritirato). Ricarica la pagina.",
  notNextStatus: "Lo stato è già cambiato. Ricarica la pagina.",
  notFound: "Elemento non trovato.",
  forbidden: "Operazione non consentita.",
  generic: "Operazione non riuscita. Riprova.",
} as const;

const uuid = z.uuid();

/** Form: orderId + candidate "carrierId:vehicleId" (one select, so carrier and vehicle always belong together). */
export const assignSchema = z.object({
  orderId: uuid,
  candidate: z.string().transform((v, ctx) => {
    const [carrierId, vehicleId] = v.split(":");
    if (!uuid.safeParse(carrierId).success || !uuid.safeParse(vehicleId).success) {
      ctx.addIssue({ code: "custom", message: DISPATCH_MSG.chooseCandidate });
      return z.NEVER;
    }
    return { carrierId, vehicleId };
  }),
});

/** "Da gestire" (load on board of a removed carrier): direct assignment with the current address of the goods. */
export const HANDOVER_BADGE = "Da gestire: carico a bordo del padroncino rimosso";

export const handoverSchema = z.object({
  orderId: uuid,
  candidate: assignSchema.shape.candidate,
  address: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
});

/** The order waits for the admin: flag set, no carrier, still running (admin_unassign_job with the load on board). */
export function isHandoverPending(o: { handover_required_at: string | null; carrier_id: string | null; status: string }): boolean {
  return o.handover_required_at !== null && o.carrier_id === null && (o.status === "picked_up" || o.status === "in_transit");
}

export const unassignSchema = z.object({
  orderId: uuid,
  reason: z.enum(UNASSIGN_REASONS.map((r) => r.code) as [UnassignReason, ...UnassignReason[]], { error: DISPATCH_MSG.chooseReason }),
});

/** "Consegnato" by the admin = without POD: a reason is required (status history note, 2026-11-11). */
export const advanceSchema = z
  .object({
    orderId: uuid,
    to: z.enum(["picked_up", "in_transit", "delivered"]),
    note: z.string().trim().max(1000).optional().transform((v) => (v ? v : undefined)),
  })
  .refine((v) => v.to !== "delivered" || v.note !== undefined, { path: ["note"] });

type DbError = { code?: string | null; message?: string | null; details?: string | null } | null | undefined;

/** Errors of admin_assign_job / admin_unassign_job / admin_advance_order → Italian message. */
export function dispatchDbError(error: DbError): string {
  const detail = error?.details ?? "";
  switch (error?.code) {
    case "42501":
      return DISPATCH_MSG.forbidden;
    case "22023":
      if (detail === "note") return DISPATCH_MSG.noteRequired;
      if (detail === "address") return DISPATCH_MSG.addressRequired;
      return detail === "reason" ? DISPATCH_MSG.chooseReason : DISPATCH_MSG.notFound;
    case "55000":
      if (detail.startsWith("carrier_not_eligible")) return DISPATCH_MSG.carrierNotEligible;
      switch (detail) {
        case "already_taken":
          return DISPATCH_MSG.alreadyTaken;
        case "not_available":
          return DISPATCH_MSG.notAvailable;
        case "too_late":
          return DISPATCH_MSG.tooLate;
        case "vehicle_not_ready":
          return DISPATCH_MSG.vehicleNotReady;
        case "vehicle_not_suitable":
          return DISPATCH_MSG.vehicleNotSuitable;
        case "not_assigned":
          return DISPATCH_MSG.notAssigned;
        case "not_handover":
          return DISPATCH_MSG.notHandover;
        default:
          return DISPATCH_MSG.notNextStatus; // admin_advance_order: detail = current status
      }
  }
  return DISPATCH_MSG.generic;
}

/** Orders list filters (status sets; "da-assegnare" also needs carrier_id null). */
export const ORDER_FILTERS: { key: string; label: string; statuses: string[] | null; unassigned?: boolean; handover?: boolean }[] = [
  { key: "tutti", label: "Tutti", statuses: null },
  { key: "da-gestire", label: "Da gestire", statuses: ["picked_up", "in_transit"], unassigned: true, handover: true },
  { key: "da-assegnare", label: "Da assegnare", statuses: ["paid"], unassigned: true },
  { key: "in-corso", label: "In corso", statuses: ["assigned", "picked_up", "in_transit"] },
  { key: "consegnati", label: "Consegnati", statuses: ["delivered", "completed"] },
  { key: "da-verificare", label: "Pagamento da verificare", statuses: ["payment_review"] },
  { key: "in-attesa", label: "In attesa di pagamento", statuses: ["pending_payment"] },
  { key: "scaduti", label: "Scaduti", statuses: ["expired"] },
];
