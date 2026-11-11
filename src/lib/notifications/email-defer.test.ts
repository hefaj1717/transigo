import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// sendEmail with `defer` (D134): the outbox row is written BEFORE sendEmail returns (so the cron / "Invia di nuovo"
// can always retry), only the Resend attempt runs later; a failing deferred attempt never throws.

const deliver = vi.fn();
vi.mock("./outbox", () => ({
  currentSender: () => ({ send: vi.fn() }),
  deliverOutboxRow: (...args: unknown[]) => deliver(...args),
  supabaseOutboxStore: () => ({}),
}));
const { sendEmail } = await import("./email");

function fakeDb() {
  const upserts: Record<string, unknown>[] = [];
  const db = {
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        upserts.push(row);
        return { select: async () => ({ data: [{ id: "e-1", status: row.status, attempts: 0 }], error: null }) };
      },
    }),
  } as unknown as SupabaseClient;
  return { db, upserts };
}

const mail = { subject: "S", html: "<p>h</p>", text: "t", templateCode: "order_delivered", to: "c@transigo.test", orderId: "o-1" };

describe("sendEmail with defer (EMAIL_TRANSPORT=resend)", () => {
  beforeEach(() => {
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    deliver.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("queues the row now and schedules the attempt instead of awaiting it", async () => {
    const tasks: (() => Promise<void>)[] = [];
    const { db, upserts } = fakeDb();
    deliver.mockResolvedValue("sent");
    expect(await sendEmail(db, mail, { defer: (t) => tasks.push(t) })).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ status: "queued", template_code: "order_delivered" });
    expect(deliver).not.toHaveBeenCalled(); // nothing sent during the request
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("a failing deferred attempt is logged, never thrown — the queued row stays for the cron", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tasks: (() => Promise<void>)[] = [];
    deliver.mockRejectedValue(new Error("network"));
    await sendEmail(fakeDb().db, mail, { defer: (t) => tasks.push(t) });
    await expect(tasks[0]()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("[email] first attempt error", { id: "e-1", error: "network" });
  });

  it("without defer (cron, scripts): the attempt is awaited as before", async () => {
    deliver.mockResolvedValue("sent");
    await sendEmail(fakeDb().db, mail);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
