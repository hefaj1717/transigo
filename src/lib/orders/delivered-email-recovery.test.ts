import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findDeliveredWithoutEmail } from "./delivered-email-recovery";

// The order ids go into the URL of a GET (PostgREST `in`): with up to 500 delivered orders they must be sent in
// chunks, or the URL (~37 chars per id) exceeds the gateway's limit and /admin/email fails. Fake client.

function fakeDb(orderIds: string[], withMail: Set<string>) {
  const inSizes: number[] = [];
  const query = (table: string) => {
    let ids: string[] = [];
    const q = {
      select: () => q, eq: () => q, gte: () => q, lte: () => q, order: () => q, limit: () => q,
      in: (col: string, values: string[]) => {
        if (col === "order_id") { ids = values; inSizes.push(values.length); }
        return q;
      },
      returns: () => Promise.resolve(table === "orders"
        ? { data: orderIds.map((id) => ({ id, order_number: id, delivered_at: "2026-11-11T10:00:00Z" })), error: null }
        : { data: ids.filter((id) => withMail.has(id)).map((order_id) => ({ order_id })), error: null }),
    };
    return q;
  };
  return { db: { from: query } as unknown as SupabaseClient, inSizes };
}

describe("findDeliveredWithoutEmail", () => {
  it("asks the outbox in chunks of at most 100 ids and merges the answers", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `o${i}`);
    const withMail = new Set(ids.filter((_, i) => i % 2 === 0));
    const { db, inSizes } = fakeDb(ids, withMail);
    const missing = await findDeliveredWithoutEmail(db, new Date(0), new Date());
    expect(inSizes).toEqual([100, 100, 50]);
    expect(missing.map((m) => m.orderId)).toEqual(ids.filter((_, i) => i % 2 === 1));
  });

  it("no delivered orders: no outbox query", async () => {
    const { db, inSizes } = fakeDb([], new Set());
    expect(await findDeliveredWithoutEmail(db, new Date(0), new Date())).toEqual([]);
    expect(inSizes).toEqual([]);
  });
});
