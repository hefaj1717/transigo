import { z } from "zod";
import type { CarrierStatus } from "@/lib/auth/routing";
import { LEG_STEPS, recipientNameSchema, type ExecErrorView } from "./execution";

// Pure helpers for the job execution Server Actions (src/app/(padroncino)/padroncino/le-mie-corse/[id]/actions.ts)
// and execution-server.ts. Kept out of the "use server" file on purpose: every export there is a public endpoint.
//
// The schemas check only the SHAPE of the input (ids, enum values, numbers). Order of steps, pickup day, photos,
// assignment and job status are decided by the database (carrier_record_step, register_order_photo,
// delete_order_photo, complete_delivery, Storage policies) — never repeated here.
// No identity field: the carrier is always auth.uid() in the database; unknown keys are stripped by z.object().

/** Steps, photos and POD: an active carrier, or a suspended one finishing its accepted jobs (D116). */
export const canExecuteJobs = (status: CarrierStatus | null): boolean => status === "active" || status === "suspended";

const legIndex = z.number().int().min(0).max(20);
/** Optional one-time position (owner 2026-11-11, pyt. 4); the database ignores invalid values (valid_position). */
const coordinate = z.number().finite().nullish();

export const recordStepInput = z.object({
  orderId: z.uuid(),
  legIndex,
  step: z.enum(LEG_STEPS),
  lat: coordinate,
  lng: coordinate,
});

export const photoKind = z.enum(["pickup", "delivery"]);

/** `path` only on "Riprova": the path the browser got the first time (same file → same path). */
export const photoUploadInput = z.object({ orderId: z.uuid(), legIndex, kind: photoKind, path: z.string().max(200).optional() });
export const registerPhotoInput = z.object({ orderId: z.uuid(), legIndex, kind: photoKind, path: z.string().max(200) });
export const deletePhotoInput = z.object({ photoId: z.uuid() });
export const signatureUploadInput = z.object({ orderId: z.uuid(), path: z.string().max(200).optional() });

export const completeDeliveryInput = z.object({
  orderId: z.uuid(),
  recipientName: recipientNameSchema,
  signaturePath: z.string().max(200),
  lat: coordinate,
  lng: coordinate,
});

export type ExecFailure = { ok: false } & ExecErrorView;

/**
 * Signed upload URL for ONE file (`signedUrl`: PUT target with progress, XHR). `token`/`signedUrl` null + `alreadyUploaded: true`: the file at `path` is already in Storage
 * (an earlier attempt arrived) — the browser goes straight to the registration.
 */
export type UploadTicket = { ok: true; path: string; token: string | null; signedUrl: string | null; alreadyUploaded: boolean } | ExecFailure;
export type RecordStepResult = { ok: true; message: string; newlyRecorded: boolean; orderStatus: string } | ExecFailure;
export type RegisterPhotoResult = { ok: true; message: string; photoId: string; newlyRegistered: boolean } | ExecFailure;
export type DeletePhotoResult = { ok: true; message: string } | ExecFailure;
export type CompleteDeliveryResult = { ok: true; message: string; newlyDelivered: boolean } | ExecFailure;
