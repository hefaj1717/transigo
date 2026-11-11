import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendOrderDeliveredEmail } from "@/lib/orders/customer-emails";
import {
  completeDeliveryInput,
  deletePhotoInput,
  photoUploadInput,
  recordStepInput,
  registerPhotoInput,
  signatureUploadInput,
  type CompleteDeliveryResult,
  type DeletePhotoResult,
  type ExecFailure,
  type RecordStepResult,
  type RegisterPhotoResult,
  type UploadTicket,
} from "./execution-actions";
import {
  EXEC_MSG,
  executionDbError,
  isAlreadyUploaded,
  isPhotoPath,
  isSignaturePath,
  liveSteps,
  photoPath,
  porterSummaries,
  signaturePath,
  type ExecLeg,
  type PhotoKind,
  type PorterLegTerms,
  type PorterSummary,
  type StepRecord,
  type StepRow,
  type WorkedRow,
} from "./execution";
import type { JobNotifyDeps } from "./jobs-server";

// Carrier job execution — server side (plan docs/plany/realizacja-kursu.md, krok 3; D69, D116, D130).
//
// Every RPC and every signed upload URL runs with the carrier's OWN session client (`db`): the database decides
// the order of steps, the pickup day, the photos, the assignment and the job status (carrier_record_step,
// register_order_photo, delete_order_photo, complete_delivery, Storage insert policies). Nothing of that is
// repeated here — this file only checks the input shape and maps errors to Italian texts (executionDbError).
//
// Files never pass through Next.js: the browser uploads to Storage with a signed upload URL made here with the
// session (so the bucket's insert policy and limits apply; the object's owner is the carrier — checked by the
// RPCs), then registers the file through the RPC.
//
// The service role is used for exactly two things, each only AFTER the RPC succeeded:
//   • removing the file of a photo delete_order_photo has just deleted (browsers cannot delete objects);
//   • queuing the order_delivered e-mail after complete_delivery.
// It is a factory (`deps.serviceDb()`), so it is not even created before that. Kept apart from the Server
// Actions so tests/rls can run it against the local database.

export type ExecutionDeps = Pick<JobNotifyDeps, "serviceDb" | "appUrl">;

type DbError = { code?: string | null; message?: string | null; details?: string | null } | null;

const fail = (message: string, refresh = false): ExecFailure => ({ ok: false, message, refresh });

/** Database error → Italian text; unexpected ones are logged (codes only, never personal data). */
function dbFailure(where: string, error: DbError): ExecFailure {
  const view = executionDbError(error);
  if (view.message === EXEC_MSG.generic) console.error(`[execution] ${where}:`, error?.code ?? "", error?.details ?? "", error?.message ?? "");
  return { ok: false, ...view };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export async function recordStep(db: SupabaseClient, input: unknown): Promise<RecordStepResult> {
  const parsed = recordStepInput.safeParse(input);
  if (!parsed.success) return fail(EXEC_MSG.forbidden);
  const { orderId, legIndex, step, lat, lng } = parsed.data;
  const { data, error } = await db
    .rpc("carrier_record_step", { p_order_id: orderId, p_leg_index: legIndex, p_step: step, p_lat: lat ?? null, p_lng: lng ?? null })
    .single<{ recorded_at: string; newly_recorded: boolean; order_status: string }>();
  if (error || !data) return dbFailure("carrier_record_step", error);
  // A repeated tap of the same step (newly_recorded = false) is a success too.
  return { ok: true, message: EXEC_MSG.stepSaved, newlyRecorded: data.newly_recorded, orderStatus: data.order_status };
}

// ---------------------------------------------------------------------------
// Signed upload URLs (photos, signature)
// ---------------------------------------------------------------------------

type StorageError = { statusCode?: string | number; message?: string } | null;

async function uploadTicket(db: SupabaseClient, bucket: "order-photos" | "pod-signatures", path: string, retry: boolean): Promise<UploadTicket> {
  const { data, error } = await db.storage.from(bucket).createSignedUploadUrl(path);
  if (!error && data) return { ok: true, path: data.path, token: data.token, signedUrl: data.signedUrl, alreadyUploaded: false };
  const e = error as StorageError;
  // "Riprova" after an upload that did arrive: the file is there — register it.
  if (retry && isAlreadyUploaded(e)) return { ok: true, path, token: null, signedUrl: null, alreadyUploaded: true };
  // Refused by the bucket's insert policy: not (any more) assigned to this carrier, or the job is not running.
  if (String(e?.statusCode) === "403") return fail(EXEC_MSG.notInProgress, true);
  console.error(`[execution] signed upload URL (${bucket}):`, e?.statusCode ?? "", e?.message ?? "");
  return fail(EXEC_MSG.generic);
}

/** "Scatta foto": a signed upload URL for one photo (new path, or the same path on "Riprova"). */
export async function createPhotoUpload(db: SupabaseClient, input: unknown): Promise<UploadTicket> {
  const parsed = photoUploadInput.safeParse(input);
  if (!parsed.success) return fail(EXEC_MSG.forbidden);
  const { orderId, path } = parsed.data;
  if (path !== undefined && !isPhotoPath(orderId, path)) return fail(EXEC_MSG.photoInvalid);
  return uploadTicket(db, "order-photos", path ?? photoPath(orderId, randomUUID()), path !== undefined);
}

/** Signature PNG of the recipient (bucket policy: only while in_transit). */
export async function createSignatureUpload(db: SupabaseClient, input: unknown): Promise<UploadTicket> {
  const parsed = signatureUploadInput.safeParse(input);
  if (!parsed.success) return fail(EXEC_MSG.forbidden);
  const { orderId, path } = parsed.data;
  if (path !== undefined && !isSignaturePath(orderId, path)) return fail(EXEC_MSG.signature);
  return uploadTicket(db, "pod-signatures", path ?? signaturePath(orderId, randomUUID()), path !== undefined);
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/** After the upload: register_order_photo checks the object (owner, type, size) — idempotent for "Riprova". */
export async function registerPhoto(db: SupabaseClient, input: unknown): Promise<RegisterPhotoResult> {
  const parsed = registerPhotoInput.safeParse(input);
  if (!parsed.success) return fail(EXEC_MSG.forbidden);
  const { orderId, legIndex, kind, path } = parsed.data;
  const { data, error } = await db
    .rpc("register_order_photo", { p_order_id: orderId, p_leg_index: legIndex, p_kind: kind, p_storage_path: path })
    .single<{ photo_id: string; newly_registered: boolean }>();
  if (error || !data) return dbFailure("register_order_photo", error);
  return { ok: true, message: EXEC_MSG.photoSaved, photoId: data.photo_id, newlyRegistered: data.newly_registered };
}

/**
 * delete_order_photo decides (author, step still open) and returns the path; only then the file is removed with
 * the service role. A file that cannot be removed is logged: it is no longer registered, so nobody sees it.
 */
export async function deletePhoto(db: SupabaseClient, input: unknown, deps: ExecutionDeps): Promise<DeletePhotoResult> {
  const parsed = deletePhotoInput.safeParse(input);
  if (!parsed.success) return fail(EXEC_MSG.forbidden);
  const { data: path, error } = await db.rpc("delete_order_photo", { p_photo_id: parsed.data.photoId });
  if (error) return dbFailure("delete_order_photo", error);
  if (typeof path === "string" && path) {
    try {
      const { error: removeError } = await deps.serviceDb().storage.from("order-photos").remove([path]);
      if (removeError) throw removeError;
    } catch (e) {
      console.error("[execution] photo file not removed", { photoId: parsed.data.photoId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // null = already deleted (double tap) — the photo is gone either way.
  return { ok: true, message: EXEC_MSG.photoRemoved };
}

// ---------------------------------------------------------------------------
// "Conferma consegna" (POD)
// ---------------------------------------------------------------------------

/**
 * complete_delivery writes POD, porter minutes and `delivered` in one transaction. After it succeeded — also on a
 * repeated confirmation (newly_delivered = false) — the order_delivered e-mail is queued: email_outbox allows ONE
 * per order (D129), so a repeat never sends a second e-mail but does re-send one whose first attempt failed.
 * An e-mail error never undoes the delivery; it is logged with the order id so it can be sent again.
 */
export async function completeDelivery(db: SupabaseClient, input: unknown, deps: ExecutionDeps): Promise<CompleteDeliveryResult> {
  const parsed = completeDeliveryInput.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === "recipientName") return fail(EXEC_MSG.recipientName);
    if (field === "signaturePath") return fail(EXEC_MSG.signatureEmpty);
    return fail(EXEC_MSG.forbidden);
  }
  const { orderId, recipientName, signaturePath: path, lat, lng } = parsed.data;
  if (!isSignaturePath(orderId, path)) return fail(EXEC_MSG.signature);

  const { data, error } = await db
    .rpc("complete_delivery", { p_order_id: orderId, p_recipient_name: recipientName, p_signature_path: path, p_lat: lat ?? null, p_lng: lng ?? null })
    .single<{ delivered_at: string; newly_delivered: boolean }>();
  if (error || !data) return dbFailure("complete_delivery", error);

  try {
    await sendOrderDeliveredEmail(deps.serviceDb(), orderId, deps.appUrl);
  } catch (e) {
    console.error("[execution] order_delivered e-mail failed — repeat the confirmation or resend", {
      orderId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return { ok: true, message: EXEC_MSG.delivered, newlyDelivered: data.newly_delivered };
}

// ---------------------------------------------------------------------------
// Screen data (krok 4): what the job screen needs to run the job
// ---------------------------------------------------------------------------

export type ExecPhoto = { id: string; legIndex: number; kind: PhotoKind; path: string; url: string | null };

/** Everything the job screen needs — serializable, sent to the browser. No positions, no user ids, no amounts. */
export type ExecutionView = {
  orderId: string;
  status: string;
  legs: ExecLeg[];
  steps: StepRecord[];
  photos: ExecPhoto[];
  porters: PorterSummary[];
  /** Taken-over leg (D130 "da gestire"): where the goods are now. */
  handover: { legIndex: number; address: string } | null;
  proof: { recipientName: string; signedAt: string } | null;
};

export type ExecutionLoadDeps = Pick<ExecutionDeps, "serviceDb">;

type LegExecRow = {
  leg_index: number;
  pickup_window_start: string;
  early_start_allowed_at: string | null;
  pickup_warehouse_id: string | null;
  delivery_warehouse_id: string | null;
  porters_count: number | null;
  porters_included_hours: number | null;
  porter_overtime_grace_minutes: number | null;
};

/**
 * Reads the job's execution state with the carrier's OWN session (RLS: only its order, its own photos, steps since
 * its assignment). Returns null when the order is not this carrier's. The service role is used for ONE value —
 * whether the bought price list has a porter overtime rate (order_charges is not readable by carriers, D77) — and
 * only AFTER the session read proved the order is this carrier's, only when a leg has porters; the browser gets
 * a yes/no (the overtime HOURS), never the rate.
 */
export async function loadJobExecution(db: SupabaseClient, userId: string, orderId: string, deps: ExecutionLoadDeps): Promise<ExecutionView | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) return null;
  const { data: order, error } = await db
    .from("orders")
    .select("id, status, order_legs(leg_index, pickup_window_start, early_start_allowed_at, pickup_warehouse_id, delivery_warehouse_id, porters_count, porters_included_hours, porter_overtime_grace_minutes)")
    .eq("id", orderId)
    .eq("carrier_id", userId)
    .maybeSingle<{ id: string; status: string; order_legs: LegExecRow[] }>();
  if (error) {
    console.error("[execution] loadJobExecution:", error.code, error.message);
    throw new Error("execution unavailable");
  }
  if (!order) return null;

  const legRows = [...order.order_legs].sort((a, b) => a.leg_index - b.leg_index);
  const [stepsRes, photosRes, handoverRes, proofRes, minutesRes] = await Promise.all([
    db.from("order_leg_steps").select("leg_index, step, created_at, reverted_at").eq("order_id", orderId).returns<StepRow[]>(),
    db.from("order_photos").select("id, leg_index, kind, storage_path, created_at").eq("order_id", orderId).order("created_at")
      .returns<{ id: string; leg_index: number; kind: PhotoKind; storage_path: string }[]>(),
    db.from("order_handovers").select("leg_index, address").eq("order_id", orderId).order("id", { ascending: false }).limit(1)
      .returns<{ leg_index: number; address: string }[]>(),
    db.from("delivery_proofs").select("recipient_name, signed_at").eq("order_id", orderId).maybeSingle<{ recipient_name: string; signed_at: string }>(),
    db.rpc("order_porters_worked_minutes", { p_order_id: orderId }),
  ]);
  for (const [what, res] of [["steps", stepsRes], ["photos", photosRes], ["handover", handoverRes], ["proof", proofRes], ["minutes", minutesRes]] as const) {
    if (res.error) {
      console.error(`[execution] loadJobExecution ${what}:`, res.error.code, res.error.message);
      throw new Error("execution unavailable");
    }
  }

  const photoRows = photosRes.data ?? [];
  let urls = new Map<string, string>();
  if (photoRows.length) {
    const { data: signed } = await db.storage.from("order-photos").createSignedUrls(photoRows.map((p) => p.storage_path), 300);
    urls = new Map((signed ?? []).filter((s) => s.signedUrl && s.path).map((s) => [s.path as string, s.signedUrl as string]));
  }

  const terms: PorterLegTerms[] = legRows.map((l) => ({
    legIndex: l.leg_index,
    persons: l.porters_count ?? 0,
    includedHours: Number(l.porters_included_hours ?? 0),
    graceMinutes: l.porter_overtime_grace_minutes ?? 0,
  }));
  const overtimeEnabled = terms.some((t) => t.persons > 0) ? await hasOvertimeRate(deps.serviceDb(), orderId) : false;

  const proof = proofRes.data;
  const handover = handoverRes.data?.[0];
  return {
    orderId,
    status: order.status,
    legs: legRows.map((l) => ({
      legIndex: l.leg_index,
      pickupWindowStart: l.pickup_window_start,
      earlyStartAllowedAt: l.early_start_allowed_at,
      pickupIsWarehouse: l.pickup_warehouse_id !== null,
      deliveryIsWarehouse: l.delivery_warehouse_id !== null,
    })),
    steps: liveSteps(stepsRes.data ?? []),
    photos: photoRows.map((p) => ({ id: p.id, legIndex: p.leg_index, kind: p.kind, path: p.storage_path, url: urls.get(p.storage_path) ?? null })),
    porters: porterSummaries(terms, (minutesRes.data ?? []) as WorkedRow[], overtimeEnabled),
    handover: handover ? { legIndex: handover.leg_index, address: handover.address } : null,
    proof: proof ? { recipientName: proof.recipient_name, signedAt: proof.signed_at } : null,
  };
}

/** Service role, ONE column, a yes/no out — call only after the session proved the order is the carrier's. */
async function hasOvertimeRate(service: SupabaseClient, orderId: string): Promise<boolean> {
  const { data, error } = await service.from("order_charges").select("porter_overtime_rate_cents").eq("order_id", orderId).maybeSingle<{ porter_overtime_rate_cents: number | null }>();
  if (error) {
    console.error("[execution] overtime rate:", error.code, error.message);
    return false; // shown without overtime hours; billing (Stage 6) reads the rate itself
  }
  return (data?.porter_overtime_rate_cents ?? 0) > 0;
}
