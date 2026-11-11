"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/admin/action-result";
import { adminDeps } from "@/lib/admin/deps";
import { formValues } from "@/lib/carriers/admin";
import { ADMIN_CLAIM_PATHS, CLAIM_ADMIN_MSG } from "@/lib/claims/admin";
import { closeClaim } from "@/lib/claims/admin-server";

// Admin actions on claims (D138). EVERY action starts with adminDeps(): the DAL checks the session before anything
// else; the admin id passed to the database is the session's, never a form field. actions.test.ts calls every
// export of this file as a non-admin.

/** Chiudi con nota: form claimId + note (shown to the customer). */
export async function closeClaimAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_CLAIM_PATHS.list);
  try {
    const result = await closeClaim(deps, formValues(fd));
    if (!result.ok) return { error: result.error };
    refresh();
    return { message: result.message, at: Date.now() };
  } catch (e) {
    console.error("[admin-claims] close:", e instanceof Error ? e.message : e);
    return { error: CLAIM_ADMIN_MSG.generic };
  }
}
