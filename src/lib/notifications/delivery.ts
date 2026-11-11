// E-mail delivery and retries through email_outbox — pure rules (owner 2026-11-11, D131). Tested in delivery.test.ts.
//
// A row is "queued" until delivered. Every delivery attempt first CLAIMS the row (conditional update
// attempts n → n + 1 while still queued), so two workers never send the same row; the provider also gets the row
// id as idempotency key, so a crash between sending and saving the result does not send twice either.
// After MAX_EMAIL_ATTEMPTS failed attempts the row becomes "failed" ("Fallito"); only an admin ("Invia di nuovo")
// starts a new series.

export const MAX_EMAIL_ATTEMPTS = 5;

export type SendResult = { ok: true; providerMessageId: string | null; captured: boolean } | { ok: false; error: string };

export type AttemptPatch =
  | { status: "sent" | "captured_dev"; provider_message_id: string | null; sent_at: string; error: null }
  | { status: "queued" | "failed"; error: string };

/** The row after attempt number `attempt` (1-based, already claimed). */
export function attemptOutcome(attempt: number, result: SendResult, now: Date): AttemptPatch {
  if (result.ok) {
    return { status: result.captured ? "captured_dev" : "sent", provider_message_id: result.providerMessageId, sent_at: now.toISOString(), error: null };
  }
  return { status: attempt >= MAX_EMAIL_ATTEMPTS ? "failed" : "queued", error: cleanError(result.error) };
}

/** May this row be attempted now? (queued and below the limit) */
export const isDue = (row: { status: string; attempts: number }): boolean => row.status === "queued" && row.attempts < MAX_EMAIL_ATTEMPTS;

/** Error text for the outbox / the admin list: one line, no e-mail addresses, ≤ 300 chars. */
export function cleanError(text: string): string {
  return text.replace(/[^\s@<>"]+@[^\s@<>"]+/g, "[address]").replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

/** Admin list labels (Italian UI). */
export function outboxStatusLabel(row: { status: string; attempts: number }): string {
  if (row.status === "failed") return "Fallito";
  if (row.status === "queued") return row.attempts > 0 ? `In riprova (${row.attempts}/${MAX_EMAIL_ATTEMPTS})` : "In coda";
  if (row.status === "sent") return "Inviato";
  if (row.status === "captured_dev") return "Registrato (sviluppo)";
  return row.status;
}

export const TEMPLATE_LABEL: Record<string, string> = {
  order_paid: "Ordine pagato",
  order_assigned: "Padroncino assegnato",
  order_delivered: "Consegna effettuata",
  carrier_submitted: "Padroncino in verifica",
  carrier_approved: "Padroncino approvato",
  carrier_rejected: "Padroncino non approvato",
  carrier_document_rejected: "Documento rifiutato",
  carrier_suspended: "Padroncino sospeso",
  carrier_reactivated: "Padroncino riattivato",
  carrier_released_job: "Rinuncia alla corsa",
  contact_request: "Richiesta di contatto",
};

/**
 * Delivered orders without an order_delivered e-mail are picked up by the cron only for a short time after the
 * delivery (window = MAX_EMAIL_ATTEMPTS runs of a 15-minute schedule, so at most 5 tries without an outbox row);
 * after that they stay in the admin list ("Consegna senza e-mail").
 */
export const CRON_INTERVAL_MINUTES = 15;
export const MISSING_DELIVERED_WINDOW_MINUTES = MAX_EMAIL_ATTEMPTS * CRON_INTERVAL_MINUTES;
/** Leave the request that confirmed the delivery time to queue its own e-mail. */
export const MISSING_DELIVERED_GRACE_MINUTES = 2;
