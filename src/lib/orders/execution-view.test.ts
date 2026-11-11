import { describe, expect, it } from "vitest";
import {
  ADMIN_NOTE_LABEL,
  customerVisiblePhotos,
  earlyStartLegs,
  EXEC_ADMIN_MSG,
  execAdminDbError,
  earlyStartSchema,
  formError,
  groupPhotos,
  lastLiveStep,
  positionUrl,
  revertSchema,
  revertTarget,
  stepTitle,
} from "./execution-view";

const s = (leg_index: number, step: string, reverted = false) => ({ leg_index, step, reverted_at: reverted ? "2026-11-11T10:00:00Z" : null });

describe("lastLiveStep / revertTarget", () => {
  it("no steps → nothing", () => {
    expect(lastLiveStep([])).toBeNull();
  });

  it("latest step in the step order, not in the row order", () => {
    expect(lastLiveStep([s(0, "departed"), s(0, "arrived_pickup"), s(0, "loaded")])).toEqual({ legIndex: 0, step: "departed" });
  });

  it("the higher leg wins (warehouse order)", () => {
    expect(lastLiveStep([s(0, "unloaded"), s(1, "arrived_pickup"), s(0, "arrived_delivery")])).toEqual({ legIndex: 1, step: "arrived_pickup" });
  });

  it("reverted steps are skipped", () => {
    expect(lastLiveStep([s(0, "arrived_pickup"), s(0, "loaded", true)])).toEqual({ legIndex: 0, step: "arrived_pickup" });
    expect(lastLiveStep([s(0, "arrived_pickup", true)])).toBeNull();
  });

  it("only while the job runs", () => {
    const rows = [s(0, "arrived_pickup")];
    for (const st of ["assigned", "picked_up", "in_transit"]) expect(revertTarget(st, rows)).not.toBeNull();
    for (const st of ["paid", "delivered", "completed", "cancelled"]) expect(revertTarget(st, rows)).toBeNull();
  });
});

describe("earlyStartLegs", () => {
  const now = new Date("2026-11-11T09:00:00Z");
  const leg = (leg_index: number, start: string, allowed: string | null = null) => ({ leg_index, pickup_window_start: start, early_start_allowed_at: allowed });

  it("a leg with a pickup day in the future", () => {
    expect(earlyStartLegs("assigned", [leg(0, "2026-11-13T08:00:00Z")], [], now)).toEqual([0]);
  });

  it("not on the pickup day or later (Europe/Rome day)", () => {
    expect(earlyStartLegs("assigned", [leg(0, "2026-11-11T20:00:00Z")], [], now)).toEqual([]);
    expect(earlyStartLegs("assigned", [leg(0, "2026-11-10T08:00:00Z")], [], now)).toEqual([]);
    // 23:30 UTC on the 11th = 00:30 on the 12th in Rome → a future day
    expect(earlyStartLegs("assigned", [leg(0, "2026-11-11T23:30:00Z")], [], now)).toEqual([0]);
  });

  it("not when already allowed or already started", () => {
    expect(earlyStartLegs("assigned", [leg(0, "2026-11-13T08:00:00Z", "2026-11-11T08:00:00Z")], [], now)).toEqual([]);
    expect(earlyStartLegs("assigned", [leg(0, "2026-11-13T08:00:00Z")], [s(0, "arrived_pickup")], now)).toEqual([]);
    expect(earlyStartLegs("assigned", [leg(0, "2026-11-13T08:00:00Z")], [s(0, "arrived_pickup", true)], now)).toEqual([0]);
  });

  it("the second leg of a warehouse order, and only while the job runs", () => {
    const legs = [leg(1, "2026-11-20T08:00:00Z"), leg(0, "2026-11-10T08:00:00Z")];
    expect(earlyStartLegs("in_transit", legs, [s(0, "arrived_pickup")], now)).toEqual([1]);
    expect(earlyStartLegs("paid", legs, [], now)).toEqual([]);
    expect(earlyStartLegs("delivered", legs, [], now)).toEqual([]);
  });
});

describe("photos", () => {
  const p = (legIndex: number, kind: "pickup" | "delivery", id: string) => ({ legIndex, kind, id });

  it("grouped leg after leg, pickup first, order kept", () => {
    const groups = groupPhotos([p(1, "delivery", "a"), p(0, "delivery", "b"), p(0, "pickup", "c"), p(0, "pickup", "d")]);
    expect(groups.map((g) => [g.legIndex, g.kind, g.photos.map((x) => x.id).join("")])).toEqual([
      [0, "pickup", "cd"],
      [0, "delivery", "b"],
      [1, "delivery", "a"],
    ]);
  });

  it("customer: pickup photos after loading, delivery photos after delivery", () => {
    const all = [p(0, "pickup", "a"), p(0, "delivery", "b")];
    expect(customerVisiblePhotos("assigned", all)).toEqual([]);
    expect(customerVisiblePhotos("picked_up", all).map((x) => x.id)).toEqual(["a"]);
    expect(customerVisiblePhotos("in_transit", all).map((x) => x.id)).toEqual(["a"]);
    expect(customerVisiblePhotos("delivered", all).map((x) => x.id)).toEqual(["a", "b"]);
    expect(customerVisiblePhotos("completed", all).map((x) => x.id)).toEqual(["a", "b"]);
    expect(customerVisiblePhotos("refunded", all)).toEqual([]);
  });
});

describe("forms and errors", () => {
  const id = "33333333-3333-4333-8333-333333333333";

  it("revert: leg, step and a reason", () => {
    expect(revertSchema.safeParse({ orderId: id, leg: "0", step: "loaded", reason: " errore " }).data).toEqual({ orderId: id, leg: 0, step: "loaded", reason: "errore" });
    const noReason = revertSchema.safeParse({ orderId: id, leg: "0", step: "loaded", reason: "  " });
    expect(formError(noReason.error!.issues)).toBe(EXEC_ADMIN_MSG.reasonRequired);
    expect(revertSchema.safeParse({ orderId: id, leg: "2", step: "loaded", reason: "x" }).success).toBe(false);
    expect(revertSchema.safeParse({ orderId: id, leg: "0", step: "flown", reason: "x" }).success).toBe(false);
    expect(formError(revertSchema.safeParse({ orderId: "x", leg: "0", step: "loaded", reason: "x" }).error!.issues)).toBe(EXEC_ADMIN_MSG.generic);
  });

  it("early start: reason up to 1000 characters", () => {
    expect(earlyStartSchema.safeParse({ orderId: id, leg: "1", reason: "a".repeat(1000) }).success).toBe(true);
    expect(earlyStartSchema.safeParse({ orderId: id, leg: "1", reason: "a".repeat(1001) }).success).toBe(false);
  });

  it("database errors", () => {
    expect(execAdminDbError({ code: "42501" })).toBe(EXEC_ADMIN_MSG.forbidden);
    expect(execAdminDbError({ code: "22023", details: "reason" })).toBe(EXEC_ADMIN_MSG.reasonRequired);
    expect(execAdminDbError({ code: "55000", details: "changed" })).toBe(EXEC_ADMIN_MSG.changed); // D136: checked under the row lock
    expect(execAdminDbError({ code: "55000", details: "something_new" })).toBe(EXEC_ADMIN_MSG.generic);
    expect(execAdminDbError({ code: "22023", details: "leg" })).toBe(EXEC_ADMIN_MSG.notFound);
    expect(execAdminDbError({ code: "55000", details: "no_step" })).toBe(EXEC_ADMIN_MSG.noStep);
    expect(execAdminDbError({ code: "55000", details: "already_started" })).toBe(EXEC_ADMIN_MSG.alreadyStarted);
    expect(execAdminDbError({ code: "55000", details: "not_in_progress" })).toBe(EXEC_ADMIN_MSG.notInProgress);
    expect(execAdminDbError({ code: "XX000" })).toBe(EXEC_ADMIN_MSG.generic);
  });

  it("titles and positions", () => {
    expect(stepTitle(0, "loaded", 1)).toBe("Carico completato");
    expect(stepTitle(1, "loaded", 2)).toBe("Tratta 2 · Carico completato");
    expect(positionUrl(45.1, 9.2)).toBe("https://www.google.com/maps/search/?api=1&query=45.1,9.2");
    expect(positionUrl(null, null)).toBeNull();
  });
});

describe("ADMIN_NOTE_LABEL", () => {
  it("has an Italian label for every note kind the database allows (order_admin_notes_kind_check)", () => {
    for (const kind of ["delivered_without_pod", "status_changed", "step_reverted", "early_start", "handover"]) {
      expect(ADMIN_NOTE_LABEL[kind], kind).toBeTruthy();
    }
  });
});
