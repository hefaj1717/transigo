// Carrier job execution — pure logic (plan docs/plany/realizacja-kursu.md, D69, D130). Tested in execution.test.ts.
// DISPLAY ONLY: the database decides everything (carrier_record_step: order, pickup day, photos; complete_delivery;
// order_porters_worked_minutes computes the porter time). Times shown in Europe/Rome.
import { z } from "zod";
import { porterOvertimeCost } from "../pricing/overtime";
import { JOB_TIME_ZONE, romeDay } from "./jobs";

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Same order as the database enum order_leg_step. */
export const LEG_STEPS = ["arrived_pickup", "loaded", "departed", "arrived_delivery", "unloaded"] as const;
export type LegStep = (typeof LEG_STEPS)[number];
export type PhotoKind = "pickup" | "delivery";

export const isLegStep = (v: unknown): v is LegStep => typeof v === "string" && (LEG_STEPS as readonly string[]).includes(v);

/** A step row as a session reads it (order_leg_steps: no position, no user id). */
export type StepRow = { leg_index: number; step: string; created_at: string; reverted_at: string | null };
export type StepRecord = { legIndex: number; step: LegStep; createdAt: string };

/** Live steps only (reverted ones are history for the admin), in execution order. */
export function liveSteps(rows: readonly StepRow[]): StepRecord[] {
  return rows
    .filter((r) => r.reverted_at === null && isLegStep(r.step))
    .map((r) => ({ legIndex: r.leg_index, step: r.step as LegStep, createdAt: r.created_at }))
    .sort((a, b) => a.legIndex - b.legIndex || LEG_STEPS.indexOf(a.step) - LEG_STEPS.indexOf(b.step));
}

export type ExecLeg = {
  legIndex: number;
  pickupWindowStart: string;
  earlyStartAllowedAt: string | null;
  pickupIsWarehouse: boolean;
  deliveryIsWarehouse: boolean;
};

/** Photo the step needs before it can be closed (≥ 1 own photo of that leg). */
export function photoKindForStep(step: LegStep): PhotoKind | null {
  return step === "loaded" ? "pickup" : step === "unloaded" ? "delivery" : null;
}

/** Button text of the next step. */
export function stepButtonLabel(step: LegStep, leg: Pick<ExecLeg, "pickupIsWarehouse" | "deliveryIsWarehouse">): string {
  switch (step) {
    case "arrived_pickup":
      return leg.pickupIsWarehouse ? "Sono arrivato al magazzino" : "Sono arrivato al ritiro";
    case "loaded":
      return "Carico completato";
    case "departed":
      return "Inizia il viaggio";
    case "arrived_delivery":
      return leg.deliveryIsWarehouse ? "Sono arrivato al magazzino" : "Sono arrivato alla consegna";
    case "unloaded":
      return leg.deliveryIsWarehouse ? "Scarico in magazzino completato" : "Scarico completato";
  }
}

/** Timeline text of a recorded step. */
export const STEP_DONE_LABEL: Record<LegStep, string> = {
  arrived_pickup: "Arrivato al ritiro",
  loaded: "Carico completato",
  departed: "Partito",
  arrived_delivery: "Arrivato alla consegna",
  unloaded: "Scarico completato",
};

/** What to ask before closing a step (shown above the button). */
export const STEP_HINT: Partial<Record<LegStep, string>> = {
  loaded: "Fotografa la merce caricata (almeno una foto).",
  unloaded: "Fotografa la merce scaricata (almeno una foto).",
};

/** "2026-11-11" — the calendar day in Rome (the database compares the same way). */
export function romeDateKey(d: Date | string): string {
  return (typeof d === "string" ? new Date(d) : d).toLocaleDateString("en-CA", { timeZone: JOB_TIME_ZONE });
}

export type NextAction =
  | {
      kind: "step";
      legIndex: number;
      step: LegStep;
      label: string;
      photoKind: PhotoKind | null;
      /** Before the pickup day (and no early start allowed): "Potrai iniziare da …" — the button stays disabled. */
      notBefore: string | null;
    }
  | { kind: "pod" } // every step done, status in_transit: "Conferma consegna"
  | { kind: "none" }; // not running (assigned to someone else, delivered, …)

/** Statuses in which a job runs (steps, photos, admin corrections) — the one copy; the database checks the same. */
const RUNNING = new Set(["assigned", "picked_up", "in_transit"]);
export const isJobRunning = (status: string) => RUNNING.has(status);

/** The one next action of the job — same rules as carrier_record_step (display only). */
export function nextAction(input: { status: string; legs: readonly ExecLeg[]; steps: readonly StepRecord[]; now?: Date }): NextAction {
  if (!isJobRunning(input.status)) return { kind: "none" };
  const done = new Set(input.steps.map((s) => `${s.legIndex}:${s.step}`));
  const legs = [...input.legs].sort((a, b) => a.legIndex - b.legIndex);
  for (const leg of legs) {
    for (const step of LEG_STEPS) {
      if (done.has(`${leg.legIndex}:${step}`)) continue;
      let notBefore: string | null = null;
      if (
        step === "arrived_pickup" &&
        leg.earlyStartAllowedAt === null &&
        !(leg.legIndex === 0 && input.status !== "assigned") &&
        romeDateKey(leg.pickupWindowStart) > romeDateKey(input.now ?? new Date())
      ) {
        notBefore = `Potrai iniziare da ${romeDay(leg.pickupWindowStart)}.`;
      }
      return { kind: "step", legIndex: leg.legIndex, step, label: stepButtonLabel(step, leg), photoKind: photoKindForStep(step), notBefore };
    }
  }
  return input.status === "in_transit" ? { kind: "pod" } : { kind: "none" };
}

/** "In magazzino": leg 1 unloaded at the warehouse, leg 2 not started yet (model A, D117 — known limitation). */
export function isInWarehouse(legs: readonly ExecLeg[], steps: readonly StepRecord[]): boolean {
  if (legs.length < 2) return false;
  const has = (leg: number, step: LegStep) => steps.some((s) => s.legIndex === leg && s.step === step);
  return has(0, "unloaded") && !has(1, "arrived_pickup");
}

// ---------------------------------------------------------------------------
// Porter working time (D69) — the value comes from the database (order_porters_worked_minutes)
// ---------------------------------------------------------------------------

/** 65 → "1 h 05 min"; 45 → "45 min"; 120 → "2 h". */
export function formatWorkedMinutes(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  return rest === 0 ? `${h} h` : `${h} h ${String(rest).padStart(2, "0")} min`;
}

/** "both" = package porters of the leg (D67); "loading" / "unloading" = help per side (D182). */
export type PorterTimeSide = "both" | "loading" | "unloading";
export type PorterLegTerms = { legIndex: number; side?: PorterTimeSide; persons: number; includedHours: number; graceMinutes: number };
/** A row of order_porters_worked_minutes (no side = "both") or of order_loading_help_minutes (D182). */
export type WorkedRow = { leg_index: number; side?: PorterTimeSide; worked_minutes: number; complete: boolean };
export type PorterSummary = {
  legIndex: number;
  side: PorterTimeSide;
  workedMinutes: number;
  workedLabel: string;
  includedLabel: string;
  complete: boolean;
  /** Started hours over the included time, per person (D68) — shown without amounts (Stage 6). */
  overtimeHours: number;
};

/**
 * Per leg with porters: the server's minutes + the order's terms → what the carrier and the recipient see.
 * `overtimeEnabled` = the bought price list had an overtime rate (D68; read by the server). The hours use the same
 * rule as the billing (porterOvertimeCost), without amounts.
 */
export function porterSummaries(terms: readonly PorterLegTerms[], worked: readonly WorkedRow[], overtimeEnabled: boolean): PorterSummary[] {
  const order = { both: 0, loading: 1, unloading: 2 } as const;
  return terms
    .filter((t) => t.persons > 0)
    .sort((a, b) => a.legIndex - b.legIndex || order[a.side ?? "both"] - order[b.side ?? "both"])
    .map((t) => {
      const side = t.side ?? "both";
      const row = worked.find((w) => w.leg_index === t.legIndex && (w.side ?? "both") === side);
      const workedMinutes = row?.worked_minutes ?? 0;
      const cost = porterOvertimeCost({
        workedMinutes,
        terms: { persons: t.persons, includedHours: t.includedHours, overtimeRatePerPersonCents: overtimeEnabled ? 1 : null, overtimeGraceMinutes: t.graceMinutes, carrierShare: null },
        vatRateBp: 0,
      });
      return {
        legIndex: t.legIndex,
        side,
        workedMinutes,
        workedLabel: formatWorkedMinutes(workedMinutes),
        includedLabel: `${t.includedHours} h`,
        complete: row?.complete ?? false,
        overtimeHours: cost.ok ? cost.overtimeHours : 0,
      };
    });
}

/** Porter columns of an order leg: package porters (D67) and / or help per side (D182). */
export type PorterLegColumns = {
  leg_index: number;
  porters_count: number;
  porters_included_hours: number | null;
  porter_overtime_grace_minutes?: number | null;
  loading_porters?: number | null;
  loading_hours?: number | null;
  unloading_porters?: number | null;
  unloading_hours?: number | null;
};

/** The porter terms of a leg: one "both" entry for package porters, otherwise one per side with help. */
export function porterTermsOfLeg(l: PorterLegColumns): PorterLegTerms[] {
  const grace = l.porter_overtime_grace_minutes ?? 0;
  const out: PorterLegTerms[] = [];
  if (l.porters_count > 0) out.push({ legIndex: l.leg_index, side: "both", persons: l.porters_count, includedHours: Number(l.porters_included_hours ?? 0), graceMinutes: grace });
  if ((l.loading_porters ?? 0) > 0) out.push({ legIndex: l.leg_index, side: "loading", persons: l.loading_porters!, includedHours: Number(l.loading_hours ?? 0), graceMinutes: grace });
  if ((l.unloading_porters ?? 0) > 0) out.push({ legIndex: l.leg_index, side: "unloading", persons: l.unloading_porters!, includedHours: Number(l.unloading_hours ?? 0), graceMinutes: grace });
  return out;
}

export const hasAnyPorters = (l: PorterLegColumns) => porterTermsOfLeg(l).length > 0;

/** "Carico: " / "Scarico: " before the time of one side (D182); nothing for package porters. */
export const porterSidePrefix = (side: PorterTimeSide) => (side === "loading" ? "Carico: " : side === "unloading" ? "Scarico: " : "");

// ---------------------------------------------------------------------------
// Photos and signature
// ---------------------------------------------------------------------------

/** Browser resize before upload (owner 2026-11-11): longer side ~1600 px, JPEG ~80 %. */
export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_JPEG_QUALITY = 0.8;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024; // = bucket order-photos
export const PHOTOS_MAX_PER_STEP = 10; // = register_order_photo
export const SIGNATURE_MAX_BYTES = 512 * 1024; // = bucket pod-signatures

/** Size after resizing: keeps the ratio, never enlarges, integers ≥ 1. */
export function scaledSize(width: number, height: number, maxSide = PHOTO_MAX_SIDE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** order-photos path made by the browser ONCE per photo, so "Riprova" re-sends the same file to the same path. */
export function photoPath(orderId: string, fileId: string): string {
  return `${orderId}/${fileId}.jpg`;
}
export function signaturePath(orderId: string, fileId: string): string {
  return `${orderId}/${fileId}.png`;
}
export function isPhotoPath(orderId: string, path: string): boolean {
  return new RegExp(`^${orderId}/${UUID}\\.jpg$`).test(path);
}
export function isSignaturePath(orderId: string, path: string): boolean {
  return new RegExp(`^${orderId}/${UUID}\\.png$`).test(path);
}

/** Storage answers "already exists" when a retried upload had in fact arrived — that is a success for "Riprova". */
export function isAlreadyUploaded(error: { statusCode?: string | number; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return String(error.statusCode) === "409" || /already exists|duplicate/i.test(error.message ?? "");
}

type StorageError = { statusCode?: string | number; status?: number; message?: string; name?: string } | null | undefined;

/**
 * Result of a direct upload to Storage (signed upload URL) as the carrier sees it. `null` = the file is there
 * (uploaded now, or by an earlier attempt — "Riprova"). The bucket enforces size and type: 413 = too big.
 */
export function uploadErrorMessage(error: StorageError, what: "photo" | "signature"): ExecErrorView | null {
  if (!error || isAlreadyUploaded(error)) return null;
  const code = String(error.statusCode ?? "");
  if (code === "413") return { message: what === "photo" ? EXEC_MSG.photoTooBig : EXEC_MSG.signature, refresh: false };
  if (code === "403") return { message: EXEC_MSG.notInProgress, refresh: true };
  if (code === "400" || code === "415" || code === "422") return { message: what === "photo" ? EXEC_MSG.photoInvalid : EXEC_MSG.signature, refresh: false };
  // No status = the request never got an answer (offline, timeout): the same file stays on screen for "Riprova".
  return { message: EXEC_MSG.network, refresh: false };
}

export const recipientNameSchema =z.string().trim().min(1, "Scrivi il nome di chi riceve la merce.").max(200, "Massimo 200 caratteri.");

// ---------------------------------------------------------------------------
// Database errors → Italian messages
// ---------------------------------------------------------------------------

export const EXEC_MSG = {
  stepSaved: "Passaggio registrato.",
  delivered: "Consegna confermata. Grazie!",
  photoSaved: "Foto salvata.",
  photoRemoved: "Foto rimossa.",
  notAssigned: "Questa corsa non è più assegnata a te.",
  notInProgress: "La corsa non è più in corso. Ricarica la pagina.",
  wrongStep: "Questo passaggio è già cambiato. Ricarica la pagina.",
  tooEarly: "Puoi iniziare solo dal giorno del ritiro.",
  photoRequired: "Aggiungi almeno una foto prima di continuare.",
  stepClosed: "Questo passaggio è già concluso: le foto non si possono più cambiare.",
  tooManyPhotos: `Massimo ${PHOTOS_MAX_PER_STEP} foto per questo passaggio.`,
  photoInvalid: "La foto non è arrivata o non è valida. Premi «Riprova».",
  photoTooBig: "La foto è troppo grande anche dopo la riduzione. Scattane un'altra.",
  stepsMissing: "Completa prima tutti i passaggi della corsa.",
  recipientName: "Scrivi il nome di chi riceve la merce.",
  signature: "La firma non è stata salvata. Chiedi di firmare di nuovo.",
  signatureEmpty: "Chiedi al destinatario di firmare nel riquadro.",
  forbidden: "Operazione non consentita.",
  network: "Connessione assente o lenta. Controlla la rete e premi «Riprova».",
  generic: "Si è verificato un errore. Riprova tra poco.",
} as const;

type DbError = { code?: string | null; message?: string | null; details?: string | null } | null | undefined;

/** `refresh`: the job changed under the carrier (status, step, assignment) → reload the page data. */
export type ExecErrorView = { message: string; refresh: boolean };

export function executionDbError(error: DbError): ExecErrorView {
  const detail = error?.details ?? "";
  const fail = (message: string, refresh = false): ExecErrorView => ({ message, refresh });
  switch (error?.code) {
    case "42501":
      return fail(EXEC_MSG.forbidden);
    case "22023":
      switch (detail) {
        case "path":
        case "file":
          return fail(EXEC_MSG.photoInvalid);
        case "recipient_name":
          return fail(EXEC_MSG.recipientName);
        case "signature":
          return fail(EXEC_MSG.signature);
        default:
          return fail(EXEC_MSG.wrongStep, true);
      }
    case "55000":
      if (detail.startsWith("wrong_step")) return fail(EXEC_MSG.wrongStep, true);
      switch (detail) {
        case "not_assigned":
          return fail(EXEC_MSG.notAssigned, true);
        case "not_in_progress":
          return fail(EXEC_MSG.notInProgress, true);
        case "too_early":
          return fail(EXEC_MSG.tooEarly);
        case "photo_required":
          return fail(EXEC_MSG.photoRequired);
        case "step_closed":
          return fail(EXEC_MSG.stepClosed, true);
        case "too_many_photos":
          return fail(EXEC_MSG.tooManyPhotos);
        case "steps_missing":
          return fail(EXEC_MSG.stepsMissing, true);
      }
  }
  return fail(EXEC_MSG.generic);
}

/**
 * Suffix of the porters' working time: " · in corso" while the job runs; once the order is delivered (e.g. closed
 * by the admin without the app) an incomplete measurement is "non misurato", never "in corso".
 */
export function porterTimeSuffix(complete: boolean, orderStatus: string): string {
  if (complete) return "";
  return orderStatus === "delivered" || orderStatus === "completed" ? " · non misurato" : " · in corso";
}
