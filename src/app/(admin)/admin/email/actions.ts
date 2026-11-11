"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/admin/action-result";
import { adminDeps } from "@/lib/admin/deps";
import { ADMIN_EMAIL_PATHS, resendDeliveredEmail, resendOutboxEmail } from "@/lib/notifications/admin-outbox";

// "Invia di nuovo" on /admin/email (D131). EVERY action starts with adminDeps(): the DAL checks the session
// before anything else; the admin is the session's, never a form field. actions.test.ts calls every export as a
// non-admin.

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

/** Form: id (email_outbox row). */
export async function resendEmailAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_EMAIL_PATHS.list);
  try {
    const result = await resendOutboxEmail(deps, str(fd, "id"));
    if (!result.ok) return { error: result.error };
    refresh();
    return { message: result.message, at: Date.now() };
  } catch (e) {
    console.error("[admin-email] resend:", e instanceof Error ? e.message : e);
    return { error: "Operazione non riuscita." };
  }
}

/** Form: orderId (delivered order without order_delivered e-mail). */
export async function resendDeliveredEmailAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const deps = await adminDeps(ADMIN_EMAIL_PATHS.list);
  try {
    const result = await resendDeliveredEmail(deps, str(fd, "orderId"));
    if (!result.ok) return { error: result.error };
    refresh();
    return { message: result.message, at: Date.now() };
  } catch (e) {
    console.error("[admin-email] resend delivered:", e instanceof Error ? e.message : e);
    return { error: "Operazione non riuscita." };
  }
}
