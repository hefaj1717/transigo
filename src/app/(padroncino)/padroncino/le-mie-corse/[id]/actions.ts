"use server";

import { revalidatePath } from "next/cache";
import { requireArea } from "@/lib/auth/session";
import {
  canExecuteJobs,
  type CompleteDeliveryResult,
  type DeletePhotoResult,
  type ExecFailure,
  type RecordStepResult,
  type RegisterPhotoResult,
  type UploadTicket,
} from "@/lib/carriers/execution-actions";
import { EXEC_MSG } from "@/lib/carriers/execution";
import {
  completeDelivery,
  createPhotoUpload,
  createSignatureUpload,
  deletePhoto,
  recordStep,
  registerPhoto,
} from "@/lib/carriers/execution-server";
import { jobNotifyDeps } from "@/lib/carriers/job-deps";
import { JOB_PATHS } from "@/lib/carriers/jobs";
import { CARRIER_PATHS } from "@/lib/carriers/onboarding";
import { createClient } from "@/lib/supabase/server";

// Job execution in the carrier PWA (plan docs/plany/realizacja-kursu.md, D130). EVERY export of this file is a
// public endpoint — only the actions live here; helpers are in src/lib/carriers/execution-actions.ts.
//
// Order: requireArea("padroncino") (redirects anyone else) → carrier status from the session (active or
// suspended, D116) → execution-server.ts with the carrier's OWN session (zod shape check, then the RPC / signed
// upload URL; the database decides order, day, photos and assignment) → revalidatePath. No identity is read from
// the input. Only Italian EXEC_MSG texts go back to the browser.
// Tested in actions.test.ts ("every export as a non-carrier") and tests/rls/carrier-execution-server.test.ts.

const PATH = (orderId: string) => JOB_PATHS.my_job(orderId);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refused = (): ExecFailure => ({ ok: false, message: EXEC_MSG.forbidden, refresh: false });

async function session() {
  const ctx = await requireArea("padroncino", JOB_PATHS.mine);
  return canExecuteJobs(ctx.carrierStatus) ? ctx : null;
}

/** The order id of a valid input, for revalidatePath only (never used to decide anything). */
const orderIdOf = (input: unknown): string | null => {
  const id = (input as { orderId?: unknown } | null)?.orderId;
  return typeof id === "string" && UUID_RE.test(id) ? id : null;
};

function revalidateJob(orderId: string | null, wide = false) {
  if (!orderId) return;
  revalidatePath(PATH(orderId));
  if (!wide) return;
  revalidatePath(JOB_PATHS.mine);
  revalidatePath(CARRIER_PATHS.home);
  revalidatePath(`/cliente/ordini/${orderId}`);
  revalidatePath(`/admin/ordini/${orderId}`);
}

async function guarded<T>(where: string, run: () => Promise<T>): Promise<T | ExecFailure> {
  try {
    return await run();
  } catch (e) {
    console.error(`[execution] ${where}:`, e instanceof Error ? e.message : e);
    return { ok: false, message: EXEC_MSG.generic, refresh: false };
  }
}

/** Next step of the job: { orderId, legIndex, step, lat?, lng? }. */
export async function recordStepAction(input: unknown): Promise<RecordStepResult> {
  if (!(await session())) return refused();
  const result = await guarded("recordStepAction", async () => recordStep(await createClient(), input));
  if (result.ok || result.refresh) revalidateJob(orderIdOf(input), true);
  return result;
}

/** Signed upload URL for a photo: { orderId, legIndex, kind, path? } (path only on "Riprova"). */
export async function createPhotoUploadAction(input: unknown): Promise<UploadTicket> {
  if (!(await session())) return refused();
  return guarded("createPhotoUploadAction", async () => createPhotoUpload(await createClient(), input));
}

/** After the upload: { orderId, legIndex, kind, path }. */
export async function registerPhotoAction(input: unknown): Promise<RegisterPhotoResult> {
  if (!(await session())) return refused();
  const result = await guarded("registerPhotoAction", async () => registerPhoto(await createClient(), input));
  if (result.ok || result.refresh) revalidateJob(orderIdOf(input));
  return result;
}

/** Remove an own photo while its step is open: { photoId, orderId? } (orderId only for the page refresh). */
export async function deletePhotoAction(input: unknown): Promise<DeletePhotoResult> {
  if (!(await session())) return refused();
  const result = await guarded("deletePhotoAction", async () => deletePhoto(await createClient(), input, jobNotifyDeps()));
  if (result.ok || result.refresh) revalidateJob(orderIdOf(input));
  return result;
}

/** Signed upload URL for the recipient's signature: { orderId, path? }. */
export async function createSignatureUploadAction(input: unknown): Promise<UploadTicket> {
  if (!(await session())) return refused();
  return guarded("createSignatureUploadAction", async () => createSignatureUpload(await createClient(), input));
}

/** "Conferma consegna": { orderId, recipientName, signaturePath, lat?, lng? }. */
export async function completeDeliveryAction(input: unknown): Promise<CompleteDeliveryResult> {
  if (!(await session())) return refused();
  const result = await guarded("completeDeliveryAction", async () => completeDelivery(await createClient(), input, jobNotifyDeps()));
  if (result.ok || result.refresh) revalidateJob(orderIdOf(input), true);
  return result;
}
