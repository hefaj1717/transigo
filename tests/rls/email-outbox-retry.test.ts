import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_EMAIL_ATTEMPTS } from "@/lib/notifications/delivery";
import { resendOutboxEmail } from "@/lib/notifications/admin-outbox";
import { processOutbox, supabaseOutboxStore, type EmailSender } from "@/lib/notifications/outbox";
import { findDeliveredWithoutEmail, recoverDeliveredEmails } from "@/lib/orders/delivered-email-recovery";
import { ORDER_DELIVERED_TEMPLATE } from "@/lib/notifications/templates/order-customer-updates";
import { deleteCreatedUsers, service, type TestUser } from "./helpers";
import { check, setupJobContext, teardownJobContext } from "./job-fixtures";
import { complete, doLeg, runningJob, signature } from "./execution-fixtures";

// E-mail retries (D131) on the LOCAL database: the conditional claim really prevents double sending, the limit
// of 5 attempts, "Invia di nuovo", delivered orders without the order_delivered e-mail.

let admin: TestUser;
const store = supabaseOutboxStore(service);

beforeAll(async () => {
  ({ admin } = await setupJobContext());
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

async function queuedRow(extra: Record<string, unknown> = {}) {
  return (await check(service.from("email_outbox").insert({
    template_code: `test_${randomUUID().slice(0, 8)}`, event_key: "", to_address: "cliente@example.com",
    subject: "Prova", html: "<p>Prova</p>", text_body: "Prova", status: "queued", ...extra,
  }).select("id").single())).id as string;
}
const outboxRow = (id: string) => check(service.from("email_outbox").select("status, attempts, error, sent_at, provider_message_id").eq("id", id).single());

function recorder(fail: boolean): EmailSender & { calls: string[] } {
  const calls: string[] = [];
  return { name: "resend", calls, send: async (m) => (calls.push(m.idempotencyKey), fail ? { ok: false, error: "resend 503 unavailable" } : { ok: true, providerMessageId: `re_${m.idempotencyKey}`, captured: false }) };
}

/** Delivered order through the RPCs only — no e-mail queued. */
async function deliveredWithoutEmail() {
  const { orderId, c } = await runningJob();
  await doLeg(c.user, orderId, 0);
  await check(complete(c.user, orderId, "Lucia", await signature(c.user, orderId)));
  return orderId;
}

describe("email_outbox retries", () => {
  it("concurrent claims of the same row: exactly one wins", async () => {
    const id = await queuedRow();
    const results = await Promise.all(Array.from({ length: 5 }, () => store.claim(id, 0)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await outboxRow(id)).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("two cron runs at the same time send a row once", async () => {
    const id = await queuedRow();
    const s = recorder(false);
    await Promise.all([processOutbox(store, s, 1000), processOutbox(store, s, 1000)]);
    expect(s.calls.filter((c) => c === id)).toEqual([id]);
    expect(await outboxRow(id)).toMatchObject({ status: "sent", attempts: 1, provider_message_id: `re_${id}`, error: null });
    expect((await outboxRow(id)).sent_at).not.toBeNull();
  });

  it("5 failed attempts → failed; «Invia di nuovo» starts a new series and is audited", async () => {
    const id = await queuedRow();
    const s = recorder(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let run = 0; run < MAX_EMAIL_ATTEMPTS + 2; run++) await processOutbox(store, s, 1000);
    vi.restoreAllMocks();
    expect(s.calls.filter((c) => c === id)).toHaveLength(MAX_EMAIL_ATTEMPTS);
    expect(await outboxRow(id)).toMatchObject({ status: "failed", attempts: 5, error: "resend 503 unavailable" });

    const deps = { admin: { userId: admin.id, email: admin.email }, serviceDb: service, appUrl: "https://transigo.example" };
    // Development transport (EMAIL_TRANSPORT unset = outbox): the new attempt is "captured".
    expect(await resendOutboxEmail(deps, id)).toEqual({ ok: true, message: "E-mail inviata." });
    expect(await outboxRow(id)).toMatchObject({ status: "captured_dev", attempts: 1, error: null });
    expect(await resendOutboxEmail(deps, id)).toMatchObject({ ok: false }); // already sent: nothing to resend
    const log = await check(service.from("audit_log").select("action, actor_id, data").eq("entity_id", id));
    expect(log).toEqual([{ action: "email.resend", actor_id: admin.id, data: { template: expect.stringMatching(/^test_/), order_id: null } }]);
  });
});

describe("delivered orders without order_delivered e-mail", () => {
  it("found, queued once by the recovery, never twice", async () => {
    const orderId = await deliveredWithoutEmail();
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600_000);
    expect((await findDeliveredWithoutEmail(service, hourAgo, now)).map((m) => m.orderId)).toContain(orderId);

    // The cron leaves 2 minutes to the confirming request; pretend the delivery was 5 minutes ago.
    const later = new Date(now.getTime() + 5 * 60_000);
    const first = await recoverDeliveredEmails(service, "https://transigo.example", later);
    expect(first.queued).toBeGreaterThanOrEqual(1);
    await recoverDeliveredEmails(service, "https://transigo.example", later);
    const mails = await check(service.from("email_outbox").select("id").eq("order_id", orderId).eq("template_code", ORDER_DELIVERED_TEMPLATE));
    expect(mails).toHaveLength(1);
    expect((await findDeliveredWithoutEmail(service, hourAgo, later)).map((m) => m.orderId)).not.toContain(orderId);
  });

  it("older than the cron window: left to the admin list", async () => {
    const orderId = await deliveredWithoutEmail();
    const muchLater = new Date(Date.now() + 2 * 3600_000);
    await recoverDeliveredEmails(service, "https://transigo.example", muchLater);
    expect(await check(service.from("email_outbox").select("id").eq("order_id", orderId).eq("template_code", ORDER_DELIVERED_TEMPLATE))).toHaveLength(0);
  });
});
