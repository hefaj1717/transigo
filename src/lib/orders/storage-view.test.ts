import { describe, expect, it } from "vitest";
import { storageView, type StorageStep } from "./storage-view";

const legs = [
  { leg_index: 1, pickup_window_start: "2026-11-20T14:00:00Z" },
  { leg_index: 0, pickup_window_start: "2026-11-15T08:00:00Z" },
];
const step = (leg_index: number, s: string, created_at: string, reverted_at: string | null = null): StorageStep => ({ leg_index, step: s, created_at, reverted_at });

describe("storageView (D139, model A)", () => {
  it("paid, nothing done yet: incoming; planned entry and paid until from the legs", () => {
    expect(storageView({ status: "assigned", order_legs: legs, order_leg_steps: [] })).toEqual({
      phase: "incoming", storedAt: null, leftAt: null, plannedEntry: "2026-11-15T08:00:00Z", paidUntil: "2026-11-20T14:00:00Z",
    });
  });

  it("leg 0 unloaded → stored since then; a reverted step does not count", () => {
    const steps = [step(0, "loaded", "2026-11-15T08:40:00Z"), step(0, "unloaded", "2026-11-15T09:30:00Z")];
    expect(storageView({ status: "in_transit", order_legs: legs, order_leg_steps: steps })).toMatchObject({ phase: "stored", storedAt: "2026-11-15T09:30:00Z" });
    const reverted = [step(0, "unloaded", "2026-11-15T09:30:00Z", "2026-11-15T09:35:00Z")];
    expect(storageView({ status: "in_transit", order_legs: legs, order_leg_steps: reverted }).phase).toBe("incoming");
  });

  it("leg 1 loaded → left; delivered → delivered", () => {
    const steps = [step(0, "unloaded", "2026-11-15T09:30:00Z"), step(1, "loaded", "2026-11-20T14:20:00Z")];
    expect(storageView({ status: "in_transit", order_legs: legs, order_leg_steps: steps })).toMatchObject({ phase: "left", leftAt: "2026-11-20T14:20:00Z" });
    expect(storageView({ status: "delivered", order_legs: legs, order_leg_steps: steps }).phase).toBe("delivered");
  });
});
