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

/** Facchinaggio (D165): assigned → picked_up → delivered, without in_transit (admin_advance_order checks the same). */
export const PORTERS_NEXT_STATUS: Partial<Record<string, { to: "picked_up" | "delivered"; label: string }>> = {
  assigned: { to: "picked_up", label: "Segna lavoro iniziato" },
  picked_up: { to: "delivered", label: "Segna lavoro concluso" },
};

/** The admin's next step for an order of this service; storage orders have none (no carrier). */
export function nextStatusFor(status: string, serviceType?: string | null) {
  if (serviceType === "storage") return undefined;
  return serviceType === "porters" ? PORTERS_NEXT_STATUS[status] : NEXT_STATUS[status];
}

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
  unassignedHandover: "Padroncino rimosso: l'ordine è «da gestire». Assegna un nuovo padroncino qui sotto.",
  allUnloaded: "La merce è già stata scaricata a destinazione: usa «Segna come consegnato» con il motivo.",
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
  // Facchinaggio (D164–D167)
  portersAssigned: "Facchini assegnati.",
  chooseTeam: "Scegli un padroncino.",
  teamNotSuitable: "Il padroncino non offre il facchinaggio o la sua squadra è più piccola di quella richiesta.",
  workStarted: "Il lavoro è già iniziato: il padroncino non si può rimuovere. Usa «Segna lavoro concluso» con il motivo.",
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

/** "Da gestire" (D130, D136): the carrier was removed with the load on board, or while the goods are in the warehouse. */
export const HANDOVER_BADGE = {
  on_board: "Da gestire: carico a bordo del padroncino rimosso",
  in_warehouse: "Da gestire: merce in magazzino, padroncino rimosso",
} as const;
export type HandoverKind = keyof typeof HANDOVER_BADGE;

type LegLike = { leg_index: number };
type StepLike = { leg_index: number; step: string; reverted_at: string | null };
const live = (steps: readonly StepLike[], leg: number, step: string) => steps.some((s) => s.leg_index === leg && s.step === step && !s.reverted_at);

/**
 * What "Rimuovi padroncino" will do — mirrors admin_unassign_job (the database decides; this only picks the text):
 *   back_to_list  — nothing loaded (assigned): back to 'paid' and to the carriers' list;
 *   on_board      — a leg loaded and not unloaded (or the status moved by the admin without steps) → da gestire;
 *   in_warehouse  — a leg finished, the next one not loaded → da gestire on the next leg (D136);
 *   all_unloaded  — every leg unloaded, POD missing → refused ("Consegnato" with a reason).
 */
export function removalOutcome(status: string, legs: readonly LegLike[], steps: readonly StepLike[]): "back_to_list" | HandoverKind | "all_unloaded" {
  const sorted = [...legs].sort((a, b) => a.leg_index - b.leg_index);
  if (sorted.some((l) => live(steps, l.leg_index, "loaded") && !live(steps, l.leg_index, "unloaded"))) return "on_board";
  if (status !== "picked_up" && status !== "in_transit") return "back_to_list";
  if (!steps.some((s) => !s.reverted_at)) return "on_board"; // moved by the admin without any step
  const unfinished = sorted.filter((l) => !live(steps, l.leg_index, "unloaded"));
  return unfinished.length ? "in_warehouse" : "all_unloaded";
}

/**
 * Kind of a pending "da gestire" order, from its steps: the removal reverted the 'loaded' of the handover leg (same
 * transaction, reverted_at = handover_required_at) → on board; otherwise the leg before it was finished → warehouse.
 */
export function handoverKind(o: { handover_required_at: string | null; handover_leg_index: number | null }, steps: readonly StepLike[]): HandoverKind {
  const leg = o.handover_leg_index;
  if (leg === null || leg === 0 || !o.handover_required_at) return "on_board";
  const at = new Date(o.handover_required_at).getTime();
  const loadedOnBoard = steps.some((s) => s.leg_index === leg && s.step === "loaded" && s.reverted_at && new Date(s.reverted_at).getTime() === at);
  return !loadedOnBoard && live(steps, leg - 1, "unloaded") ? "in_warehouse" : "on_board";
}

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

/** "Assegna facchini": orderId + carrierId (no vehicle, D164). */
export const assignPortersSchema = z.object({ orderId: uuid, carrierId: z.uuid({ error: DISPATCH_MSG.chooseTeam }) });

/**
 * "Squadra insufficiente" (D167): a porter job in progress whose carrier no longer offers facchinaggio or whose
 * team became smaller than the persons of the job — the admin may reassign it. Mirrors admin_set_carrier_porters.
 */
export function teamTooSmall(
  o: { service_type?: string | null; status: string; carrier_id: string | null },
  persons: number | null | undefined,
  carrier: { offers_porters: boolean; porters_team_size: number | null } | null | undefined,
): boolean {
  if (o.service_type !== "porters" || !o.carrier_id || !carrier || persons == null) return false;
  if (o.status !== "assigned" && o.status !== "picked_up") return false;
  return !carrier.offers_porters || (carrier.porters_team_size ?? 0) < persons;
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
        case "all_unloaded":
          return DISPATCH_MSG.allUnloaded;
        case "team_not_suitable":
          return DISPATCH_MSG.teamNotSuitable;
        case "work_started":
          return DISPATCH_MSG.workStarted;
        default:
          return DISPATCH_MSG.notNextStatus; // admin_advance_order: detail = current status
      }
  }
  return DISPATCH_MSG.generic;
}

/**
 * Orders list filters (status sets; "da-assegnare" also needs carrier_id null). `byIds`: the orders come from
 * another table — payments still to check (D96: also a duplicate payment of a paid order) or refunds to complete.
 */
export const ORDER_FILTERS: { key: string; label: string; statuses: string[] | null; unassigned?: boolean; handover?: boolean; byIds?: "payment_review" | "refunds" }[] = [
  { key: "tutti", label: "Tutti", statuses: null },
  { key: "da-gestire", label: "Da gestire", statuses: ["picked_up", "in_transit"], unassigned: true, handover: true },
  { key: "da-assegnare", label: "Da assegnare", statuses: ["paid"], unassigned: true },
  { key: "in-corso", label: "In corso", statuses: ["assigned", "picked_up", "in_transit"] },
  { key: "consegnati", label: "Consegnati", statuses: ["delivered", "completed"] },
  { key: "annullamento", label: "Annullamento in revisione", statuses: ["cancellation_review"] },
  { key: "da-verificare", label: "Pagamento da verificare", statuses: null, byIds: "payment_review" },
  { key: "rimborsi", label: "Rimborsi da completare", statuses: null, byIds: "refunds" },
  { key: "in-attesa", label: "In attesa di pagamento", statuses: ["pending_payment"] },
  { key: "scaduti", label: "Scaduti", statuses: ["expired"] },
];
