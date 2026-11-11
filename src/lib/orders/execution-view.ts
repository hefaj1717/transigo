// How the job execution (steps, photos, POD, porter time) is shown to the admin and to the customer, plus the
// admin's corrections: "Annulla ultimo passo" (admin_revert_last_step) and "Consenti inizio anticipato"
// (admin_allow_early_start). Pure — tested in execution-view.test.ts.
import { z } from "zod";
import { LEG_STEPS, romeDateKey, STEP_DONE_LABEL, type LegStep, type PhotoKind } from "@/lib/carriers/execution";

export { STEP_DONE_LABEL };

/** Statuses in which the job runs (the admin functions accept only these). */
const RUNNING = new Set(["assigned", "picked_up", "in_transit"]);
export const isJobRunning = (status: string) => RUNNING.has(status);

type StepLike = { leg_index: number; step: string; reverted_at: string | null };

const stepOrder = (s: string) => (LEG_STEPS as readonly string[]).indexOf(s);

/**
 * The step admin_revert_last_step would undo: the live step of the highest leg, latest in the step order
 * (the database orders by leg_index desc, step desc — the enum order).
 */
export function lastLiveStep(rows: readonly StepLike[]): { legIndex: number; step: LegStep } | null {
  let best: StepLike | null = null;
  for (const r of rows) {
    if (r.reverted_at !== null || stepOrder(r.step) < 0) continue;
    if (!best || r.leg_index > best.leg_index || (r.leg_index === best.leg_index && stepOrder(r.step) > stepOrder(best.step))) best = r;
  }
  return best ? { legIndex: best.leg_index, step: best.step as LegStep } : null;
}

/** "Annulla ultimo passo" is offered only while the job runs and something can be undone. */
export function revertTarget(status: string, rows: readonly StepLike[]): { legIndex: number; step: LegStep } | null {
  return isJobRunning(status) ? lastLiveStep(rows) : null;
}

type EarlyLeg = { leg_index: number; pickup_window_start: string; early_start_allowed_at: string | null };

/**
 * Legs for which "Consenti inizio anticipato" makes sense: the job runs, the leg has not started (no live
 * arrived_pickup), no permission yet, and its pickup day (Europe/Rome) is still in the future — from that day on
 * the carrier may start anyway.
 */
export function earlyStartLegs(status: string, legs: readonly EarlyLeg[], rows: readonly StepLike[], now: Date = new Date()): number[] {
  if (!isJobRunning(status)) return [];
  const today = romeDateKey(now);
  return [...legs]
    .sort((a, b) => a.leg_index - b.leg_index)
    .filter((l) => l.early_start_allowed_at === null)
    .filter((l) => romeDateKey(l.pickup_window_start) > today)
    .filter((l) => !rows.some((r) => r.leg_index === l.leg_index && r.step === "arrived_pickup" && r.reverted_at === null))
    .map((l) => l.leg_index);
}

/** "Tratta 1 · Carico completato" (the leg only when the order has two). */
export function stepTitle(legIndex: number, step: LegStep, legsCount: number): string {
  return legsCount > 1 ? `Tratta ${legIndex + 1} · ${STEP_DONE_LABEL[step]}` : STEP_DONE_LABEL[step];
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export const PHOTO_KIND_LABEL: Record<PhotoKind, string> = { pickup: "Ritiro", delivery: "Consegna" };

export type PhotoGroup<P> = { legIndex: number; kind: PhotoKind; photos: P[] };

/** Photos grouped leg after leg, pickup before delivery; empty groups left out. Input order is kept inside a group. */
export function groupPhotos<P extends { legIndex: number; kind: PhotoKind }>(photos: readonly P[]): PhotoGroup<P>[] {
  const groups: PhotoGroup<P>[] = [];
  const legs = [...new Set(photos.map((p) => p.legIndex))].sort((a, b) => a - b);
  for (const legIndex of legs) {
    for (const kind of ["pickup", "delivery"] as const) {
      const list = photos.filter((p) => p.legIndex === legIndex && p.kind === kind);
      if (list.length) groups.push({ legIndex, kind, photos: list });
    }
  }
  return groups;
}

const LOADED_OR_LATER = new Set(["picked_up", "in_transit", "delivered", "completed"]);
const DELIVERED = new Set(["delivered", "completed"]);

/**
 * What the customer sees (owner 2026-11-11): pickup photos once the goods are loaded (status picked_up or later),
 * delivery photos only after the delivery. RLS already limits the rows to the customer's own order.
 */
export function customerVisiblePhotos<P extends { kind: PhotoKind }>(status: string, photos: readonly P[]): P[] {
  if (DELIVERED.has(status)) return [...photos];
  if (LOADED_OR_LATER.has(status)) return photos.filter((p) => p.kind === "pickup");
  return [];
}

export const isDeliveredStatus = (status: string) => DELIVERED.has(status);
export const isLoadedOrLater = (status: string) => LOADED_OR_LATER.has(status);

// ---------------------------------------------------------------------------
// Internal admin notes (order_admin_notes)
// ---------------------------------------------------------------------------

export const ADMIN_NOTE_LABEL: Record<string, string> = {
  delivered_without_pod: "Consegnato senza firma e foto",
  status_changed: "Cambio stato",
  step_reverted: "Passo annullato",
  early_start: "Inizio anticipato consentito",
};

// ---------------------------------------------------------------------------
// Admin corrections: forms, messages, database errors
// ---------------------------------------------------------------------------

export const EXEC_ADMIN_MSG = {
  reverted: (title: string) => `Passo annullato: ${title}. Il padroncino lo vedrà di nuovo da fare.`,
  earlyStartAllowed: "Inizio anticipato consentito: il padroncino può iniziare la tratta da subito.",
  earlyStartAlready: "L'inizio anticipato era già consentito.",
  reasonRequired: "Scrivi il motivo (massimo 1000 caratteri).",
  changed: "Nel frattempo il padroncino ha registrato un altro passo. Ricarica la pagina.",
  noStep: "Non c'è nessun passo da annullare. Ricarica la pagina.",
  notInProgress: "La corsa non è in corso (forse già consegnata). Ricarica la pagina.",
  alreadyStarted: "La tratta è già iniziata: l'inizio anticipato non serve più.",
  forbidden: "Operazione non consentita.",
  notFound: "Elemento non trovato.",
  generic: "Operazione non riuscita. Riprova.",
} as const;

const uuid = z.uuid();
const reason = z.string().trim().min(1).max(1000);
const legIndex = z.coerce.number().int().min(0).max(1);

/** Revert form: the step the admin SAW (leg + step) — the server refuses when the last step is another one. */
export const revertSchema = z.object({
  orderId: uuid,
  leg: legIndex,
  step: z.enum(LEG_STEPS),
  reason,
});

export const earlyStartSchema = z.object({ orderId: uuid, leg: legIndex, reason });

/** Form error → message: the reason is the only field the admin types. */
export function formError(issues: readonly { path: readonly PropertyKey[] }[]): string {
  return issues.some((i) => i.path[0] === "reason") ? EXEC_ADMIN_MSG.reasonRequired : EXEC_ADMIN_MSG.generic;
}

type DbError = { code?: string | null; details?: string | null } | null | undefined;

/** Errors of admin_revert_last_step / admin_allow_early_start → Italian message. */
export function execAdminDbError(error: DbError): string {
  const detail = error?.details ?? "";
  switch (error?.code) {
    case "42501":
      return EXEC_ADMIN_MSG.forbidden;
    case "22023":
      return detail === "reason" ? EXEC_ADMIN_MSG.reasonRequired : EXEC_ADMIN_MSG.notFound;
    case "55000":
      if (detail === "no_step") return EXEC_ADMIN_MSG.noStep;
      if (detail === "already_started") return EXEC_ADMIN_MSG.alreadyStarted;
      if (detail === "not_in_progress") return EXEC_ADMIN_MSG.notInProgress;
      return EXEC_ADMIN_MSG.changed;
  }
  return EXEC_ADMIN_MSG.generic;
}

/** Google Maps link of a recorded position (admins only, D128). */
export function positionUrl(lat: number | null, lng: number | null): string | null {
  if (lat === null || lng === null) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
