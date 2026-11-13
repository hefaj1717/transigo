import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuoteMemo, keepQuoteResult } from "./quote-memo";

type R = { ok: boolean; error?: { code: string } };

afterEach(() => vi.useRealTimers());

describe("createQuoteMemo", () => {
  it("reuses the request for the same key, also while it is still on its way", async () => {
    const memo = createQuoteMemo<R>();
    const load = vi.fn(async () => ({ ok: true }));
    const a = memo("k", load);
    const b = memo("k", load);
    expect(a).toBe(b);
    await a;
    await memo("k", load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("asks again for another key and after the ttl", async () => {
    vi.useFakeTimers();
    const memo = createQuoteMemo<R>({ ttlMs: 1000 });
    const load = vi.fn(async () => ({ ok: true }));
    await memo("a", load);
    await memo("b", load);
    expect(load).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1001);
    await memo("a", load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("forgets transient failures and rejected requests", async () => {
    const memo = createQuoteMemo<R>({ keep: keepQuoteResult });
    const load = vi.fn(async (): Promise<R> => ({ ok: false, error: { code: "maps_unavailable" } }));
    await memo("k", load);
    await Promise.resolve();
    await memo("k", load);
    expect(load).toHaveBeenCalledTimes(2);

    const failing = vi.fn(async (): Promise<R> => {
      throw new Error("offline");
    });
    await expect(memo("x", failing)).rejects.toThrow();
    await Promise.resolve();
    await expect(memo("x", failing)).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("keeps business errors (the same state gives the same answer)", async () => {
    const memo = createQuoteMemo<R>({ keep: keepQuoteResult });
    const load = vi.fn(async (): Promise<R> => ({ ok: false, error: { code: "max_distance" } }));
    await memo("k", load);
    await Promise.resolve();
    await memo("k", load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("drops the oldest entry beyond max", async () => {
    const memo = createQuoteMemo<R>({ max: 2 });
    const load = vi.fn(async () => ({ ok: true }));
    await memo("a", load);
    await memo("b", load);
    await memo("c", load);
    await memo("a", load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
