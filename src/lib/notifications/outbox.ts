import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { attemptOutcome, cleanError, isDue, MAX_EMAIL_ATTEMPTS, type AttemptPatch, type SendResult } from "./delivery";

// Delivery of email_outbox rows (D93, D131): the first attempt right after queuing (sendEmail), the following
// ones by the cron /api/cron/send-emails, a new series by the admin ("Invia di nuovo"). Rules in delivery.ts.
// email_outbox is service-role only (no policies) — every function here gets a service-role client.
// Logs carry only ids and template codes — never addresses or content.

export type OutboxRow = {
  id: string;
  template_code: string;
  to_address: string;
  subject: string;
  html: string;
  text_body: string;
  status: string;
  attempts: number;
};

export type OutgoingMessage = { idempotencyKey: string; to: string; subject: string; html: string; text: string };
export type EmailSender = { name: "outbox" | "resend"; send: (m: OutgoingMessage) => Promise<SendResult> };

/** Development transport: nothing leaves the app, the row is marked captured_dev. */
export const outboxSender: EmailSender = { name: "outbox", send: async () => ({ ok: true, providerMessageId: null, captured: true }) };

/** Resend API (https://resend.com/docs/api-reference/emails/send-email). Idempotency-Key = outbox row id. */
export function resendSender(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): EmailSender {
  return {
    name: "resend",
    send: async (m) => {
      try {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": m.idempotencyKey },
          body: JSON.stringify({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await res.json().catch(() => null)) as { id?: string; name?: string; message?: string } | null;
        if (!res.ok) return { ok: false, error: `resend ${res.status} ${body?.name ?? ""} ${body?.message ?? ""}` };
        return { ok: true, providerMessageId: body?.id ?? null, captured: false };
      } catch (e) {
        return { ok: false, error: `resend request failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}

/**
 * The sender for the configured transport. `null`: EMAIL_TRANSPORT=resend without RESEND_API_KEY /
 * RESEND_FROM_EMAIL — nothing is attempted (attempts are not used up), rows wait in the queue.
 */
export function currentSender(env: Record<string, string | undefined> = process.env): EmailSender | null {
  if (env.EMAIL_TRANSPORT !== "resend") return outboxSender;
  const key = env.RESEND_API_KEY?.trim();
  const from = env.RESEND_FROM_EMAIL?.trim();
  return key && from ? resendSender(key, from) : null;
}

// ---------------------------------------------------------------------------
// Store — the only place that touches email_outbox for deliveries (a fake one in the unit tests)
// ---------------------------------------------------------------------------

export type OutboxStore = {
  /** Queued rows below the attempt limit, oldest first. */
  listDue: (limit: number) => Promise<OutboxRow[]>;
  /** attempts n → n + 1 only if the row is still queued with n attempts. false = someone else took it. */
  claim: (id: string, attempts: number) => Promise<boolean>;
  finish: (id: string, patch: AttemptPatch) => Promise<void>;
};

const COLUMNS = "id, template_code, to_address, subject, html, text_body, status, attempts";

export function supabaseOutboxStore(db: SupabaseClient): OutboxStore {
  return {
    listDue: async (limit) => {
      const { data, error } = await db
        .from("email_outbox")
        .select(COLUMNS)
        .eq("status", "queued")
        .lt("attempts", MAX_EMAIL_ATTEMPTS)
        .order("created_at", { ascending: true })
        .limit(limit)
        .returns<OutboxRow[]>();
      if (error) throw new Error(`email_outbox list failed: ${error.message}`);
      return data ?? [];
    },
    claim: async (id, attempts) => {
      const { data, error } = await db
        .from("email_outbox")
        .update({ attempts: attempts + 1 })
        .eq("id", id)
        .eq("status", "queued")
        .eq("attempts", attempts)
        .select("id");
      if (error) throw new Error(`email_outbox claim failed: ${error.message}`);
      return (data ?? []).length === 1;
    },
    finish: async (id, patch) => {
      const { error } = await db.from("email_outbox").update(patch).eq("id", id);
      if (error) throw new Error(`email_outbox update failed: ${error.message}`);
    },
  };
}

export type DeliveryOutcome = "sent" | "captured" | "retry" | "failed" | "skipped";

/** One attempt for one row: claim → send → save the outcome. Never throws for a send error. */
export async function deliverOutboxRow(store: OutboxStore, sender: EmailSender, row: OutboxRow, now = new Date()): Promise<DeliveryOutcome> {
  if (!isDue(row)) return "skipped";
  if (!(await store.claim(row.id, row.attempts))) return "skipped"; // another worker has it
  const attempt = row.attempts + 1;
  let result: SendResult;
  try {
    result = await sender.send({ idempotencyKey: row.id, to: row.to_address, subject: row.subject, html: row.html, text: row.text_body });
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const patch = attemptOutcome(attempt, result, now);
  await store.finish(row.id, patch);
  if (patch.status === "queued" || patch.status === "failed") {
    console.warn("[email] attempt failed", { id: row.id, template: row.template_code, attempt, final: patch.status === "failed", error: cleanError(patch.error) });
    return patch.status === "failed" ? "failed" : "retry";
  }
  return patch.status === "sent" ? "sent" : "captured";
}

export type OutboxReport = { checked: number; sent: number; captured: number; retry: number; failed: number; skipped: number; errors: number };

/** The cron's queue run: every due row once (one attempt per run). */
export async function processOutbox(store: OutboxStore, sender: EmailSender, limit = 50, now = new Date()): Promise<OutboxReport> {
  const report: OutboxReport = { checked: 0, sent: 0, captured: 0, retry: 0, failed: 0, skipped: 0, errors: 0 };
  for (const row of await store.listDue(limit)) {
    report.checked++;
    try {
      report[await deliverOutboxRow(store, sender, row, now)]++;
    } catch (e) {
      report.errors++;
      console.error("[email] delivery error", { id: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}
