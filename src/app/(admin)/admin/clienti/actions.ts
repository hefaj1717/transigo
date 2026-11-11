"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/admin/action-result";
import { adminDeps } from "@/lib/admin/deps";
import { formValues } from "@/lib/carriers/admin";
import { ADMIN_CUSTOMER_PATHS, CUSTOMER_ADMIN_MSG } from "@/lib/customers/admin";
import { setCustomerBlocked } from "@/lib/customers/admin-server";

// Admin actions on customers (D143). EVERY action starts with adminDeps(): the DAL checks the session before anything
// else; the admin id passed to the database is the session's, never a form field. actions.test.ts calls every
// export of this file as a non-admin.

/** Blocca / Sblocca: form customerId + block ("1" | "0") + reason (code, to block). */
export async function setCustomerBlockedAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_CUSTOMER_PATHS.list);
  try {
    const result = await setCustomerBlocked(deps, formValues(fd));
    if (!result.ok) return { error: result.error };
    refresh();
    return { message: result.message, at: Date.now() };
  } catch (e) {
    console.error("[admin-customers] block:", e instanceof Error ? e.message : e);
    return { error: CUSTOMER_ADMIN_MSG.generic };
  }
}
