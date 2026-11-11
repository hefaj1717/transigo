"use server";

import { revalidatePath } from "next/cache";
import { requireArea } from "@/lib/auth/session";
import { formDataToObject } from "@/lib/auth/schemas";
import {
  acceptFormError,
  acceptJobForm,
  acceptPorterJobForm,
  canAcceptJobs,
  canReleaseJobs,
  releaseJobForm,
  type AcceptJobActionState,
  type ReleaseJobActionState,
} from "@/lib/carriers/job-actions";
import { jobNotifyDeps } from "@/lib/carriers/job-deps";
import { JOB_MSG, JOB_PATHS, myJobsHref } from "@/lib/carriers/jobs";
import { acceptJob, acceptPorterJob, releaseJob } from "@/lib/carriers/jobs-server";
import { CARRIER_PATHS } from "@/lib/carriers/onboarding";
import { createClient } from "@/lib/supabase/server";

// "Accetta la Corsa" and "Rinuncia alla corsa" (D116, D119–D121). EVERY export of this file is a public
// endpoint — only these two actions live here; helpers are in src/lib/carriers/job-actions.ts / job-deps.ts.
//
// Order: requireArea("padroncino") (redirects anyone else) → carrier status from the session → zod (orderId,
// vehicleId as uuid) → jobs-server.ts (the carrier's own session; the service role only after a successful
// RPC, for email_outbox) → revalidatePath. The carrier is ALWAYS the session's: no identity is read from the
// form. Only Italian JOB_MSG texts go back to the browser — never database / Supabase errors.
// Tested in actions.test.ts ("every export as a non-carrier").

/**
 * Accetta la Corsa: form orderId + vehicleId — or orderId + kind=porters for Facchinaggio (D164, no vehicle).
 * On success the UI goes to `href` (Le mie corse → the job).
 */
export async function acceptJobAction(_prev: AcceptJobActionState | null, fd: FormData): Promise<AcceptJobActionState> {
  const ctx = await requireArea("padroncino", JOB_PATHS.available);
  const at = Date.now();
  if (!canAcceptJobs(ctx.carrierStatus)) return { ok: false, error: JOB_MSG.notEligible, refreshList: true, at };

  const input = formDataToObject(fd);
  const porters = acceptPorterJobForm.safeParse(input);
  const parsed = porters.success ? null : acceptJobForm.safeParse(input);
  if (!porters.success && !parsed?.success) return { ok: false, ...acceptFormError(input), at };
  const orderId = porters.success ? porters.data.orderId : parsed!.data!.orderId;

  let result: Awaited<ReturnType<typeof acceptJob>>;
  try {
    const db = await createClient();
    result = porters.success
      ? await acceptPorterJob(db, ctx.userId, orderId, jobNotifyDeps())
      : await acceptJob(db, ctx.userId, orderId, parsed!.data!.vehicleId, jobNotifyDeps());
  } catch (e) {
    console.error("[jobs] acceptJobAction:", e instanceof Error ? e.message : e);
    return { ok: false, error: JOB_MSG.generic, refreshList: false, at };
  }

  revalidatePath(JOB_PATHS.available);
  revalidatePath(JOB_PATHS.available_job(orderId));
  if (!result.ok) return { ok: false, error: result.error, refreshList: result.refreshList, at };
  revalidatePath(JOB_PATHS.mine);
  revalidatePath(CARRIER_PATHS.home);
  return { ok: true, message: result.message, newlyAssigned: result.newlyAssigned, href: JOB_PATHS.my_job(orderId), at };
}

/** Rinuncia alla corsa: form orderId. The database decides the 15 min / 48 h rule (D121). */
export async function releaseJobAction(_prev: ReleaseJobActionState | null, fd: FormData): Promise<ReleaseJobActionState> {
  const ctx = await requireArea("padroncino", JOB_PATHS.mine);
  const at = Date.now();
  if (!canReleaseJobs(ctx.carrierStatus)) return { ok: false, error: JOB_MSG.forbidden, tooLate: false, at };

  const parsed = releaseJobForm.safeParse(formDataToObject(fd));
  if (!parsed.success) return { ok: false, error: JOB_MSG.notAssigned, tooLate: false, at };
  const { orderId } = parsed.data;

  let result: Awaited<ReturnType<typeof releaseJob>>;
  try {
    result = await releaseJob(await createClient(), ctx.userId, orderId, jobNotifyDeps());
  } catch (e) {
    console.error("[jobs] releaseJobAction:", e instanceof Error ? e.message : e);
    return { ok: false, error: JOB_MSG.generic, tooLate: false, at };
  }
  if (!result.ok) return { ok: false, error: result.error, tooLate: result.tooLate, at };

  revalidatePath(JOB_PATHS.mine);
  revalidatePath(JOB_PATHS.my_job(orderId));
  revalidatePath(JOB_PATHS.available);
  revalidatePath(CARRIER_PATHS.home);
  return { ok: true, message: result.message, href: myJobsHref({ esito: "rinuncia" }), at };
}
