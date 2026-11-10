import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "./email";

// sendEmail (D93, D129): the outbox row carries event_key and the upsert ignores duplicates on
// (template_code, order_id, event_key).

function fakeDb(returned: { id: string }[]) {
  const calls: { row: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
  const db = {
    from: () => ({
      upsert: (row: Record<string, unknown>, opts: Record<string, unknown>) => {
        calls.push({ row, opts });
        return { select: async () => ({ data: returned, error: null }) };
      },
    }),
  } as unknown as SupabaseClient;
  return { db, calls };
}

const mail = { subject: "S", html: "<p>h</p>", text: "t", templateCode: "order_assigned", to: "c@transigo.test", orderId: "o-1" };

describe("sendEmail", () => {
  it("passes the event key and deduplicates on template, order and event", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { db, calls } = fakeDb([{ id: "e-1" }]);
    expect(await sendEmail(db, { ...mail, eventKey: "assigned:2026-11-10T08:00:00.000Z" })).toBe(true);
    expect(calls[0].row).toMatchObject({ template_code: "order_assigned", order_id: "o-1", event_key: "assigned:2026-11-10T08:00:00.000Z" });
    expect(calls[0].opts).toEqual({ onConflict: "template_code,order_id,event_key", ignoreDuplicates: true });
  });

  it("without an event key: '' (once per template and order); a duplicate returns false", async () => {
    const { db, calls } = fakeDb([]);
    expect(await sendEmail(db, { ...mail, templateCode: "order_paid" })).toBe(false);
    expect(calls[0].row).toMatchObject({ event_key: "", order_id: "o-1" });
  });
});
