// Job screen (plan docs/plany/realizacja-kursu.md, krok 4) — pure UI state, tested in execution-ui.test.ts.
// DISPLAY ONLY: the database decides (carrier_record_step, register_order_photo, complete_delivery). These rules
// only keep the big button honest (disabled while photos upload, a photo is missing or a request is running).
import { PHOTOS_MAX_PER_STEP, type NextAction, type PhotoKind } from "./execution";

// ---------------------------------------------------------------------------
// Navigation links
// ---------------------------------------------------------------------------

export function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}

/** Apple Maps: opens the Maps app on iPhone, maps.apple.com elsewhere. */
export function appleMapsUrl(lat: number, lng: number): string {
  return `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`;
}

/** tel: link — digits and a leading + only. */
export const telHref = (phone: string): string => `tel:${phone.replace(/[^\d+]/g, "")}`;

// ---------------------------------------------------------------------------
// Photo queue: photos taken but not registered yet. A failed photo stays (same file, same path) for "Riprova".
// ---------------------------------------------------------------------------

export type PendingPhase = "preparing" | "uploading" | "registering" | "error";

export type PendingPhoto = {
  localId: string;
  legIndex: number;
  kind: PhotoKind;
  /** Storage path, fixed at the first ticket — "Riprova" re-sends to it (register_order_photo is idempotent). */
  path: string | null;
  phase: PendingPhase;
  /** 0–100 while uploading. */
  progress: number;
  error: string | null;
};

export type QueueEvent =
  | { type: "add"; localId: string; legIndex: number; kind: PhotoKind }
  | { type: "ticket"; localId: string; path: string }
  | { type: "progress"; localId: string; progress: number }
  | { type: "uploaded"; localId: string }
  | { type: "registered"; localId: string }
  | { type: "failed"; localId: string; error: string }
  | { type: "retry"; localId: string }
  | { type: "discard"; localId: string };

export function photoQueue(queue: readonly PendingPhoto[], e: QueueEvent): PendingPhoto[] {
  const patch = (p: Partial<PendingPhoto>) => queue.map((q) => (q.localId === e.localId ? { ...q, ...p } : q));
  switch (e.type) {
    case "add":
      return [...queue, { localId: e.localId, legIndex: e.legIndex, kind: e.kind, path: null, phase: "preparing", progress: 0, error: null }];
    case "ticket":
      return patch({ path: e.path, phase: "uploading", progress: 0, error: null });
    case "progress":
      return patch({ progress: Math.max(0, Math.min(100, Math.round(e.progress))) });
    case "uploaded":
      return patch({ phase: "registering", progress: 100 });
    case "registered":
    case "discard":
      return queue.filter((q) => q.localId !== e.localId);
    case "failed":
      return patch({ phase: "error", error: e.error });
    case "retry":
      // The path is kept: the same file goes to the same place (or is found there already).
      return patch({ phase: "preparing", error: null, progress: 0 });
  }
}

export const isBusy = (p: PendingPhoto): boolean => p.phase !== "error";

// ---------------------------------------------------------------------------
// The big button
// ---------------------------------------------------------------------------

export type StepButtonState =
  | { kind: "hidden" }
  | { kind: "disabled"; reason: string }
  | { kind: "ready"; confirm: boolean };

/** Steps that close the photos (irreversible) ask in an in-app dialog; the others go with one tap (owner 2026-11-11). */
export const CONFIRM_STEPS = new Set(["loaded", "unloaded"]);

export function stepButtonState(input: {
  next: NextAction;
  savedPhotos: number;
  pending: readonly PendingPhoto[];
  submitting: boolean;
}): StepButtonState {
  const { next } = input;
  if (next.kind === "none") return { kind: "hidden" };
  if (input.submitting) return { kind: "disabled", reason: "Invio in corso…" };
  if (next.kind === "pod") return { kind: "ready", confirm: false }; // the POD screen has its own confirmation
  if (next.notBefore) return { kind: "disabled", reason: next.notBefore };
  if (next.photoKind) {
    const mine = input.pending.filter((p) => p.legIndex === next.legIndex && p.kind === next.photoKind);
    if (mine.some(isBusy)) return { kind: "disabled", reason: "Attendi il caricamento delle foto." };
    if (mine.length) return { kind: "disabled", reason: "Una foto non è stata caricata: premi «Riprova» o eliminala." };
    if (input.savedPhotos < 1) return { kind: "disabled", reason: "Aggiungi almeno una foto." };
  }
  return { kind: "ready", confirm: CONFIRM_STEPS.has(next.step) };
}

/** Room left for photos of one step (saved + in the queue count). */
export const photosLeft = (saved: number, pending: number): number => Math.max(0, PHOTOS_MAX_PER_STEP - saved - pending);

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

export type Point = { x: number; y: number };

/** Total length of the strokes (CSS px). A tap or a dot is not a signature. */
export function inkLength(strokes: readonly (readonly Point[])[]): number {
  let total = 0;
  for (const s of strokes) for (let i = 1; i < s.length; i++) total += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
  return total;
}

export const MIN_SIGNATURE_INK = 40;
export const isSignatureEnough = (strokes: readonly (readonly Point[])[]): boolean => inkLength(strokes) >= MIN_SIGNATURE_INK;
