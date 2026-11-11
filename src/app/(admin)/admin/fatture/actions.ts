"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/admin/action-result";
import { adminDeps } from "@/lib/admin/deps";
import { formValues } from "@/lib/carriers/admin";
import { retryInvoice } from "@/lib/einvoice/admin-server";
import { ADMIN_INVOICE_PATHS, INVOICE_ADMIN_MSG } from "@/lib/einvoice/view";

// Admin actions on invoices (D146). EVERY action starts with adminDeps(): the DAL checks the session before anything
// else; the admin id passed to the database is the session's, never a form field. actions.test.ts calls every
// export of this file as a non-admin.

/** "Riprova": form invoiceId. */
export async function retryInvoiceAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_INVOICE_PATHS.list);
  try {
    const result = await retryInvoice(deps, formValues(fd));
    refresh();
    if (!result.ok) return { error: result.error };
    return { message: result.message, at: Date.now() };
  } catch (e) {
    console.error("[admin-invoices] retry:", e instanceof Error ? e.message : e);
    return { error: INVOICE_ADMIN_MSG.generic };
  }
}
