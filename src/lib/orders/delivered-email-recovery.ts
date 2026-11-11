import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MISSING_DELIVERED_GRACE_MINUTES,
  MISSING_DELIVERED_WINDOW_MINUTES,
} from "@/lib/notifications/delivery";
import { ORDER_DELIVERED_TEMPLATE } from "@/lib/notifications/templates/order-customer-updates";
import { sendOrderDeliveredEmail } from "./customer-emails";

// Delivered orders whose order_delivered e-mail never reached email_outbox (the e-mail step failed before the
// row was written — e.g. a database hiccup while reading the order). Found by comparing delivered orders with
// the outbox; the e-mail is queued with the normal sender (one per order, D129), so a repeat never duplicates.
// Service-role client only.

export type MissingDeliveredEmail = { orderId: string; orderNumber: string; deliveredAt: string };

export async function findDeliveredWithoutEmail(db: SupabaseClient, since: Date, until: Date, limit = 500): Promise<MissingDeliveredEmail[]> {
  const { data: orders, error } = await db
    .from("orders")
    .select("id, order_number, delivered_at")
    .in("status", ["delivered", "completed"])
    .gte("delivered_at", since.toISOString())
    .lte("delivered_at", until.toISOString())
    .order("delivered_at", { ascending: false })
    .limit(limit)
    .returns<{ id: string; order_number: string; delivered_at: string }[]>();
  if (error) throw new Error(`delivered orders: ${error.message}`);
  if (!orders?.length) return [];
  const { data: mails, error: mailError } = await db
    .from("email_outbox")
    .select("order_id")
    .eq("template_code", ORDER_DELIVERED_TEMPLATE)
    .in("order_id", orders.map((o) => o.id))
    .returns<{ order_id: string }[]>();
  if (mailError) throw new Error(`email_outbox: ${mailError.message}`);
  const withMail = new Set((mails ?? []).map((m) => m.order_id));
  return orders.filter((o) => !withMail.has(o.id)).map((o) => ({ orderId: o.id, orderNumber: o.order_number, deliveredAt: o.delivered_at }));
}

/** Cron: orders delivered in the last MISSING_DELIVERED_WINDOW_MINUTES (≈ 5 runs) get their e-mail queued. */
export async function recoverDeliveredEmails(db: SupabaseClient, appUrl: string, now = new Date()): Promise<{ found: number; queued: number; errors: number }> {
  const since = new Date(now.getTime() - MISSING_DELIVERED_WINDOW_MINUTES * 60_000);
  const until = new Date(now.getTime() - MISSING_DELIVERED_GRACE_MINUTES * 60_000);
  const missing = await findDeliveredWithoutEmail(db, since, until, 100);
  let queued = 0;
  let errors = 0;
  for (const m of missing) {
    try {
      await sendOrderDeliveredEmail(db, m.orderId, appUrl);
      queued++;
    } catch (e) {
      errors++;
      console.error("[email] order_delivered recovery failed", { orderId: m.orderId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { found: missing.length, queued, errors };
}
