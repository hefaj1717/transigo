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
import { EXEC_MSG, executionDbError, isAlreadyUploaded, isPhotoPath, isSignaturePath, photoPath, signaturePath } from "./execution";
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
  if (!error && data) return { ok: true, path: data.path, token: data.token, alreadyUploaded: false };
  const e = error as StorageError;
  // "Riprova" after an upload that did arrive: the file is there — register it.
  if (retry && isAlreadyUploaded(e)) return { ok: true, path, token: null, alreadyUploaded: true };
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
