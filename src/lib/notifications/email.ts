import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RenderedEmail } from "./templates/common";

// E-mail adapter (D93). Every e-mail goes through email_outbox: one row per template + order + event (D129), so a
// repeated webhook or a double click never sends twice, while a NEW event (e.g. a second carrier assignment)
// does. `eventKey` defaults to '' = one e-mail per template and order. The transport is chosen by EMAIL_TRANSPORT:
//   outbox (default) — development: the e-mail stays in email_outbox as "captured_dev", nothing is sent;
//   resend           — Resend API (to be wired when the domain is verified, D79); until then the row stays "queued".
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

/** Queues and (depending on the transport) sends an e-mail. Returns false when it was already queued before. */
export async function sendEmail(db: SupabaseClient, email: OutgoingEmail): Promise<boolean> {
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
    .select("id");
  if (error) throw new Error(`email_outbox insert failed: ${error.message}`);
  const id = data?.[0]?.id as string | undefined;
  if (!id) return false; // already queued (duplicate webhook / same event)

  if (transport === "outbox") {
    console.info("[email] captured (dev outbox)", { id, template: email.templateCode });
    return true;
  }
  // Resend comes with the verified domain (D79). Until then the e-mail waits in the outbox.
  console.warn("[email] Resend transport not configured yet; e-mail left queued", { id, template: email.templateCode });
  return true;
}
