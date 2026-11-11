import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/admin/server";
import { findDeliveredWithoutEmail, type MissingDeliveredEmail } from "@/lib/orders/delivered-email-recovery";
import { sendOrderDeliveredEmail } from "@/lib/orders/customer-emails";
import { MAX_EMAIL_ATTEMPTS } from "./delivery";
import { currentSender, deliverOutboxRow, supabaseOutboxStore, type OutboxRow } from "./outbox";

// Admin list of e-mails with problems (/admin/email, D131): "Fallito" rows, rows being retried, and delivered
// orders without an order_delivered e-mail. email_outbox has no RLS policies (service role only): callers check
// the admin session first (requireArea / adminDeps). audit_log gets ids and the template only (D65).

export const ADMIN_EMAIL_PATHS = { list: "/admin/email" } as const;

export type AdminOutboxDeps = { admin: { userId: string; email: string }; serviceDb: SupabaseClient; appUrl: string };
export type AdminOutboxResult = { ok: true; message: string } | { ok: false; error: string };

export type ProblemEmail = {
  id: string;
  template_code: string;
  to_address: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
  order_id: string | null;
  orders: { order_number: string } | null;
};

export const MISSING_DELIVERED_LIST_DAYS = 30;

export async function loadEmailProblems(db: SupabaseClient, now = new Date()): Promise<{ rows: ProblemEmail[]; missing: MissingDeliveredEmail[] }> {
  const { data, error } = await db
    .from("email_outbox")
    .select("id, template_code, to_address, status, attempts, error, created_at, order_id, orders(order_number)")
    .or("status.eq.failed,and(status.eq.queued,attempts.gt.0)")
    .order("created_at", { ascending: false })
    .limit(200)
    .returns<ProblemEmail[]>();
  if (error) throw new Error(`email_outbox: ${error.message}`);
  const missing = await findDeliveredWithoutEmail(db, new Date(now.getTime() - MISSING_DELIVERED_LIST_DAYS * 86_400_000), now);
  return { rows: data ?? [], missing };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Invia di nuovo": a new series of MAX_EMAIL_ATTEMPTS (attempts back to 0) and one attempt right now. */
export async function resendOutboxEmail(deps: AdminOutboxDeps, id: string): Promise<AdminOutboxResult> {
  if (!UUID.test(id)) return { ok: false, error: "E-mail non valida." };
  const { data, error } = await deps.serviceDb
    .from("email_outbox")
    .update({ status: "queued", attempts: 0, error: null })
    .eq("id", id)
    .in("status", ["failed", "queued"])
    .select("id, template_code, to_address, subject, html, text_body, status, attempts, order_id")
    .returns<(OutboxRow & { order_id: string | null })[]>();
  if (error) {
    console.error("[admin-email] reset failed", { id, code: error.code, message: error.message });
    return { ok: false, error: "Operazione non riuscita." };
  }
  const row = data?.[0];
  if (!row) return { ok: false, error: "L'e-mail è già stata inviata o non esiste più. Ricarica la pagina." };
  await audit(deps.admin, "email.resend", "email_outbox", row.id, { template: row.template_code, order_id: row.order_id }, deps.serviceDb);

  const sender = currentSender();
  if (!sender) return { ok: true, message: "E-mail rimessa in coda: l'invio non è ancora configurato (Resend)." };
  const outcome = await deliverOutboxRow(supabaseOutboxStore(deps.serviceDb), sender, row);
  if (outcome === "sent" || outcome === "captured") return { ok: true, message: "E-mail inviata." };
  return { ok: true, message: `Invio non riuscito: nuovi tentativi automatici ogni 15 minuti (massimo ${MAX_EMAIL_ATTEMPTS}).` };
}

/** "Invia di nuovo" for a delivered order without an order_delivered e-mail (one per order — never twice). */
export async function resendDeliveredEmail(deps: AdminOutboxDeps, orderId: string): Promise<AdminOutboxResult> {
  if (!UUID.test(orderId)) return { ok: false, error: "Ordine non valido." };
  const { data: order } = await deps.serviceDb.from("orders").select("status").eq("id", orderId).maybeSingle<{ status: string }>();
  if (!order || !["delivered", "completed"].includes(order.status)) return { ok: false, error: "L'ordine non risulta consegnato." };
  try {
    await sendOrderDeliveredEmail(deps.serviceDb, orderId, deps.appUrl);
  } catch (e) {
    console.error("[admin-email] order_delivered failed", { orderId, error: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "Invio non riuscito. Riprova tra poco." };
  }
  await audit(deps.admin, "email.resend", "order", orderId, { template: "order_delivered" }, deps.serviceDb);
  return { ok: true, message: "E-mail di consegna messa in invio." };
}
