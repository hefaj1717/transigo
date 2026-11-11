import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { currentSender, deliverOutboxRow, supabaseOutboxStore, type OutboxRow } from "./outbox";
import type { RenderedEmail } from "./templates/common";

// E-mail adapter (D93). Every e-mail goes through email_outbox: one row per template + order + event (D129), so a
// repeated webhook or a double click never sends twice, while a NEW event (e.g. a second carrier assignment)
// does. `eventKey` defaults to '' = one e-mail per template and order. The transport is chosen by EMAIL_TRANSPORT:
//   outbox (default) — development: the e-mail stays in email_outbox as "captured_dev", nothing is sent;
//   resend           — Resend API (needs RESEND_API_KEY, RESEND_FROM_EMAIL and the verified domain, D79): first attempt
//                      right here, retries by the cron /api/cron/send-emails, max 5, then "failed" (D131).
// `defer` (owner 2026-11-11): the row is ALWAYS written before sendEmail returns — so a failed or lost attempt is
// retried by the cron / "Invia di nuovo" — but the Resend call itself can run after the response (Next `after()`),
// so the Stripe webhook and "Conferma consegna" never wait for the provider (up to 15 s).
// Logs carry only ids and the template code — never addresses or content.

export type EmailTransport = "outbox" | "resend";

export function emailTransport(): EmailTransport {
  return process.env.EMAIL_TRANSPORT === "resend" ? "resend" : "outbox";
}

export type OutgoingEmail = RenderedEmail & {
  templateCode: string;
  to: string;
  recipientId?: string | null;
  orderId?: string | null;
  /** The event this e-mail is about (D129): '' (default) = once per template and order. */
  eventKey?: string;
};

/** Runs a task later (after the response) — `after` from next/server in a request; tests pass their own. */
export type Defer = (task: () => Promise<void>) => void;
export type SendOptions = { defer?: Defer };

/**
 * Queues and (depending on the transport) sends an e-mail. Returns false when it was already queued before.
 * With `defer` the first delivery attempt is scheduled there instead of awaited; the queued row exists either way.
 */
export async function sendEmail(db: SupabaseClient, email: OutgoingEmail, opts: SendOptions = {}): Promise<boolean> {
  const transport = emailTransport();
  const { data, error } = await db
    .from("email_outbox")
    .upsert(
      {
        template_code: email.templateCode,
        order_id: email.orderId ?? null,
        event_key: email.eventKey ?? "",
        recipient_id: email.recipientId ?? null,
        to_address: email.to,
        subject: email.subject,
        html: email.html,
        text_body: email.text,
        status: transport === "outbox" ? "captured_dev" : "queued",
      },
      { onConflict: "template_code,order_id,event_key", ignoreDuplicates: true },
    )
    .select("id, template_code, to_address, subject, html, text_body, status, attempts");
  if (error) throw new Error(`email_outbox insert failed: ${error.message}`);
  const row = data?.[0] as OutboxRow | undefined;
  if (!row) return false; // already queued (duplicate webhook / same event)

  if (transport === "outbox") {
    console.info("[email] captured (dev outbox)", { id: row.id, template: email.templateCode });
    return true;
  }
  const sender = currentSender();
  if (!sender) {
    console.warn("[email] Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL); e-mail left queued", { id: row.id, template: email.templateCode });
    return true;
  }
  // A failed attempt stays queued for the cron — it never throws to the caller (nor inside `defer`).
  const attempt = () =>
    deliverOutboxRow(supabaseOutboxStore(db), sender, row).then(
      () => undefined,
      (e) => console.error("[email] first attempt error", { id: row.id, error: e instanceof Error ? e.message : String(e) }),
    );
  if (opts.defer) opts.defer(attempt);
  else await attempt();
  return true;
}
