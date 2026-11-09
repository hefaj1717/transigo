import { z } from "zod";
import type { CarrierStatus } from "@/lib/auth/routing";
import { JOB_MSG } from "./jobs";

// Pure helpers for the carrier job Server Actions (src/app/(padroncino)/padroncino/corse/actions.ts).
// Kept out of the "use server" file on purpose: every export there is a public endpoint.
//
// Order in each action: requireArea("padroncino") → status gate (session) → zod → jobs-server.ts → revalidatePath.
// The forms carry ONLY orderId (+ vehicleId); the carrier is always the session's (auth.uid() in the RPC).
// Any other field (carrierId, userId, …) is ignored: z.object() strips unknown keys.

export const acceptJobForm = z.object({ orderId: z.uuid(), vehicleId: z.uuid() });
export const releaseJobForm = z.object({ orderId: z.uuid() });

export type AcceptJobActionState =
  | { ok: true; message: string; newlyAssigned: boolean; href: string; at: number }
  | { ok: false; error: string; refreshList: boolean; at: number };

export type ReleaseJobActionState = { ok: true; message: string; at: number } | { ok: false; error: string; at: number };

/**
 * Accept needs an ACTIVE carrier (D21, D116). Checked from the session before anything else runs; the database
 * (accept_job → carrier_job_blockers) checks it again in the same transaction.
 */
export const canAcceptJobs = (status: CarrierStatus | null): boolean => status === "active";

/** Release: active, or suspended (a suspended carrier keeps and may release its jobs, D116). */
export const canReleaseJobs = (status: CarrierStatus | null): boolean => status === "active" || status === "suspended";

/** Invalid form (not a uuid, missing field): which Italian message. Never zod's own text. */
export function acceptFormError(input: unknown): { error: string; refreshList: boolean } {
  const orderOk = z.object({ orderId: z.uuid() }).safeParse(input).success;
  return orderOk ? { error: JOB_MSG.chooseVehicle, refreshList: false } : { error: JOB_MSG.notFound, refreshList: true };
}
