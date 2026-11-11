import { describe, expect, it, vi } from "vitest";
import { attemptOutcome, cleanError, isDue, MAX_EMAIL_ATTEMPTS, MISSING_DELIVERED_WINDOW_MINUTES, outboxStatusLabel } from "./delivery";
import { currentSender, deliverOutboxRow, processOutbox, resendSender, type EmailSender, type OutboxRow, type OutboxStore } from "./outbox";

// Retry limit and "never twice" for email_outbox deliveries (D131). The store is an in-memory copy of the
// conditional update used against the database (claim: attempts n → n + 1 only while queued with n attempts).

const NOW = new Date("2026-11-11T10:00:00Z");

function memoryStore(rows: OutboxRow[]) {
  const db = new Map(rows.map((r) => [r.id, { ...r, error: null as string | null }]));
  const store: OutboxStore = {
    listDue: async (limit) => [...db.values()].filter(isDue).slice(0, limit).map((r) => ({ ...r })),
    claim: async (id, attempts) => {
      const r = db.get(id);
      if (!r || r.status !== "queued" || r.attempts !== attempts) return false;
      r.attempts = attempts + 1;
      return true;
    },
    finish: async (id, patch) => {
      Object.assign(db.get(id)!, patch);
    },
  };
  return { store, db };
}

const row = (id: string, extra: Partial<OutboxRow> = {}): OutboxRow => ({
  id, template_code: "order_delivered", to_address: "cliente@example.com", subject: "s", html: "<p>h</p>", text_body: "t", status: "queued", attempts: 0, ...extra,
});

function sender(results: ("ok" | "fail")[]): EmailSender & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "resend",
    calls,
    send: async (m) => {
      calls.push(m.idempotencyKey);
      return (results.shift() ?? "ok") === "ok" ? { ok: true, providerMessageId: `re_${calls.length}`, captured: false } : { ok: false, error: "resend 500 internal_server_error" };
    },
  };
}

describe("attempt rules", () => {
  it("failures stay queued until the 5th, which is final («Fallito»)", () => {
    for (let a = 1; a < MAX_EMAIL_ATTEMPTS; a++) expect(attemptOutcome(a, { ok: false, error: "x" }, NOW).status).toBe("queued");
    expect(attemptOutcome(MAX_EMAIL_ATTEMPTS, { ok: false, error: "x" }, NOW).status).toBe("failed");
    expect(attemptOutcome(MAX_EMAIL_ATTEMPTS, { ok: true, providerMessageId: "re_1", captured: false }, NOW))
      .toEqual({ status: "sent", provider_message_id: "re_1", sent_at: NOW.toISOString(), error: null });
  });

  it("only queued rows below the limit are due", () => {
    expect(isDue({ status: "queued", attempts: 4 })).toBe(true);
    expect(isDue({ status: "queued", attempts: 5 })).toBe(false);
    for (const status of ["sent", "failed", "captured_dev"]) expect(isDue({ status, attempts: 0 })).toBe(false);
  });

  it("errors never keep addresses; labels in Italian", () => {
    expect(cleanError("422 invalid `to` field: mario.rossi@example.com\n  bad")).toBe("422 invalid `to` field: [address] bad");
    expect(cleanError("")).toBe("unknown error");
    expect(outboxStatusLabel({ status: "failed", attempts: 5 })).toBe("Fallito");
    expect(outboxStatusLabel({ status: "queued", attempts: 2 })).toBe("In riprova (2/5)");
    expect(outboxStatusLabel({ status: "queued", attempts: 0 })).toBe("In coda");
  });

  it("missing order_delivered e-mails are retried by the cron for 5 runs of 15 minutes", () => {
    expect(MISSING_DELIVERED_WINDOW_MINUTES).toBe(75);
  });
});

describe("delivery: limit and no duplicates", () => {
  it("5 failed runs → «Fallito», then no more attempts", async () => {
    const { store, db } = memoryStore([row("a")]);
    const s = sender(["fail", "fail", "fail", "fail", "fail", "ok"]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcomes = [];
    for (let run = 0; run < 7; run++) outcomes.push(await processOutbox(store, s, 50, NOW));
    expect(s.calls).toHaveLength(MAX_EMAIL_ATTEMPTS);
    expect(db.get("a")).toMatchObject({ status: "failed", attempts: 5, error: "resend 500 internal_server_error" });
    expect(outcomes.map((o) => o.checked)).toEqual([1, 1, 1, 1, 1, 0, 0]);
    vi.restoreAllMocks();
  });

  it("success after failures: sent once, never again", async () => {
    const { store, db } = memoryStore([row("a")]);
    const s = sender(["fail", "ok"]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let run = 0; run < 4; run++) await processOutbox(store, s, 50, NOW);
    expect(s.calls).toEqual(["a", "a"]); // the row id is the provider's idempotency key on every attempt
    expect(db.get("a")).toMatchObject({ status: "sent", attempts: 2, provider_message_id: "re_2", error: null });
    vi.restoreAllMocks();
  });

  it("two workers on the same row (cron + «Invia di nuovo», two cron runs): only one sends", async () => {
    const { store } = memoryStore([row("a"), row("b")]);
    const s = sender([]);
    const [r1, r2] = await Promise.all([processOutbox(store, s, 50, NOW), processOutbox(store, s, 50, NOW)]);
    expect(s.calls.sort()).toEqual(["a", "b"]);
    expect(r1.sent + r2.sent).toBe(2);
    expect(r1.skipped + r2.skipped).toBe(2);
  });

  it("a stale row (already sent / failed / at the limit) is skipped without a claim", async () => {
    const { store } = memoryStore([]);
    const claim = vi.spyOn(store, "claim");
    const s = sender([]);
    for (const r of [row("x", { status: "sent" }), row("y", { status: "failed", attempts: 5 }), row("z", { attempts: 5 })]) {
      expect(await deliverOutboxRow(store, s, r, NOW)).toBe("skipped");
    }
    expect(claim).not.toHaveBeenCalled();
    expect(s.calls).toEqual([]);
  });

  it("a sender that throws counts as a failed attempt", async () => {
    const { store, db } = memoryStore([row("a")]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom: EmailSender = { name: "resend", send: async () => { throw new Error("socket hang up"); } };
    expect(await deliverOutboxRow(store, boom, row("a"), NOW)).toBe("retry");
    expect(db.get("a")).toMatchObject({ status: "queued", attempts: 1, error: "socket hang up" });
    vi.restoreAllMocks();
  });

  it("development transport marks rows captured_dev", async () => {
    const { store, db } = memoryStore([row("a")]);
    const s = currentSender({ EMAIL_TRANSPORT: "outbox" })!;
    expect(await processOutbox(store, s, 50, NOW)).toMatchObject({ captured: 1 });
    expect(db.get("a")).toMatchObject({ status: "captured_dev" });
  });
});

describe("Resend transport", () => {
  it("not configured → no sender (rows wait, attempts are not used up)", () => {
    expect(currentSender({ EMAIL_TRANSPORT: "resend" })).toBeNull();
    expect(currentSender({ EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_x" })).toBeNull();
    expect(currentSender({ EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_x", RESEND_FROM_EMAIL: "Transigo <no-reply@x.it>" })?.name).toBe("resend");
  });

  it("sends with the row id as Idempotency-Key; HTTP errors become failed attempts", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      void init;
      return new Response(JSON.stringify({ id: "re_123" }), { status: 200 });
    });
    const s = resendSender("re_key", "Transigo <no-reply@x.it>", fetchMock as unknown as typeof fetch);
    expect(await s.send({ idempotencyKey: "row-1", to: "a@b.it", subject: "S", html: "H", text: "T" })).toEqual({ ok: true, providerMessageId: "re_123", captured: false });
    const init = fetchMock.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("row-1");
    expect(JSON.parse(init.body as string)).toEqual({ from: "Transigo <no-reply@x.it>", to: ["a@b.it"], subject: "S", html: "H", text: "T" });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ name: "rate_limit_exceeded", message: "Too many requests" }), { status: 429 }));
    expect(await s.send({ idempotencyKey: "row-1", to: "a@b.it", subject: "S", html: "H", text: "T" }))
      .toEqual({ ok: false, error: "resend 429 rate_limit_exceeded Too many requests" });
    fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    expect(await s.send({ idempotencyKey: "row-1", to: "a@b.it", subject: "S", html: "H", text: "T" }))
      .toEqual({ ok: false, error: "resend request failed: ENOTFOUND" });
  });
});
