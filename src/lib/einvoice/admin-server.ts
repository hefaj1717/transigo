import "server-only";
import { z } from "zod";
import type { AdminDeps } from "@/lib/admin/deps";
import { issueDocumentNow } from "./server";
import { INVOICE_ADMIN_MSG } from "./view";

// "Riprova" of the admin (D146): admin_retry_invoice() (failed → pending, audit; checks the admin again) and then the
// provider right away. Called by the Server Action AFTER adminDeps() — the admin id is the session's.

export type RetryResult = { ok: true; message: string } | { ok: false; error: string };

const schema = z.object({ invoiceId: z.uuid() });

export async function retryInvoice(deps: AdminDeps, input: Record<string, string>, issue = issueDocumentNow): Promise<RetryResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVOICE_ADMIN_MSG.generic };
  const { invoiceId } = parsed.data;
  const { error } = await deps.serviceDb.rpc("admin_retry_invoice", { p_invoice_id: invoiceId, p_admin_id: deps.admin.userId }).single();
  if (error) {
    if (error.code === "55000" && error.details === "already_issued") return { ok: false, error: INVOICE_ADMIN_MSG.alreadyIssued };
    console.error("[admin-invoices] admin_retry_invoice:", { invoiceId, code: error.code });
    return { ok: false, error: INVOICE_ADMIN_MSG.generic };
  }
  const outcome = await issue(deps.serviceDb, invoiceId);
  if (outcome === "issued" || outcome === "already_issued") return { ok: true, message: INVOICE_ADMIN_MSG.retried };
  if (outcome === "failed") return { ok: false, error: INVOICE_ADMIN_MSG.retryFailed };
  return { ok: true, message: INVOICE_ADMIN_MSG.queued }; // a database error: the row is pending, the cron issues it
}
