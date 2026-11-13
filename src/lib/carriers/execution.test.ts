import { describe, expect, it } from "vitest";
import {
  porterTimeSuffix,
  EXEC_MSG, executionDbError, formatWorkedMinutes, isAlreadyUploaded, isInWarehouse, isPhotoPath, isSignaturePath, LEG_STEPS,
  liveSteps, nextAction, photoKindForStep, photoPath, porterSummaries, recipientNameSchema, romeDateKey, scaledSize,
  signaturePath, stepButtonLabel, uploadErrorMessage, type ExecLeg, type LegStep, type StepRecord,
} from "./execution";

const O = "7d0e6f3a-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const F = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const leg = (legIndex: number, pickupWindowStart: string, extra: Partial<ExecLeg> = {}): ExecLeg => ({
  legIndex, pickupWindowStart, earlyStartAllowedAt: null, pickupIsWarehouse: false, deliveryIsWarehouse: false, ...extra,
});
const rec = (legIndex: number, ...steps: LegStep[]): StepRecord[] => steps.map((step) => ({ legIndex, step, createdAt: "2026-11-11T08:00:00Z" }));
const NOW = new Date("2026-11-11T09:00:00Z"); // 10:00 in Rome
const TODAY = "2026-11-11T08:00:00Z";
const TOMORROW = "2026-11-12T07:00:00Z";

describe("liveSteps", () => {
  it("drops reverted rows and unknown steps, sorts by leg and step order", () => {
    const rows = [
      { leg_index: 1, step: "arrived_pickup", created_at: "c", reverted_at: null },
      { leg_index: 0, step: "loaded", created_at: "b", reverted_at: null },
      { leg_index: 0, step: "arrived_pickup", created_at: "a", reverted_at: null },
      { leg_index: 0, step: "departed", created_at: "x", reverted_at: "2026-11-11T10:00:00Z" },
      { leg_index: 0, step: "teleported", created_at: "y", reverted_at: null },
    ];
    expect(liveSteps(rows)).toEqual([
      { legIndex: 0, step: "arrived_pickup", createdAt: "a" },
      { legIndex: 0, step: "loaded", createdAt: "b" },
      { legIndex: 1, step: "arrived_pickup", createdAt: "c" },
    ]);
  });
});

describe("nextAction — same order as carrier_record_step", () => {
  it("walks the five steps, then the POD", () => {
    const legs = [leg(0, TODAY)];
    const seen: string[] = [];
    let steps: StepRecord[] = [];
    let status = "assigned";
    for (const s of LEG_STEPS) {
      const a = nextAction({ status, legs, steps, now: NOW });
      expect(a.kind).toBe("step");
      if (a.kind !== "step") return;
      expect(a.step).toBe(s);
      expect(a.notBefore).toBeNull();
      seen.push(a.label);
      steps = [...steps, ...rec(0, s)];
      if (s === "loaded") status = "picked_up";
      if (s === "departed") status = "in_transit";
    }
    expect(seen).toEqual(["Sono arrivato al ritiro", "Carico completato", "Inizia il viaggio", "Sono arrivato alla consegna", "Scarico completato"]);
    expect(nextAction({ status, legs, steps, now: NOW })).toEqual({ kind: "pod" });
  });

  it("two legs: leg 2 after leg 1, warehouse labels, its own pickup day", () => {
    const legs = [leg(1, TOMORROW, { pickupIsWarehouse: true }), leg(0, TODAY, { deliveryIsWarehouse: true })];
    const steps = rec(0, "arrived_pickup", "loaded", "departed", "arrived_delivery");
    expect(nextAction({ status: "in_transit", legs, steps, now: NOW })).toMatchObject({ legIndex: 0, step: "unloaded", label: "Scarico in magazzino completato", photoKind: "delivery" });
    const after = [...steps, ...rec(0, "unloaded")];
    const a = nextAction({ status: "in_transit", legs, steps: after, now: NOW });
    expect(a).toMatchObject({ kind: "step", legIndex: 1, step: "arrived_pickup", label: "Sono arrivato al magazzino" });
    expect(a.kind === "step" && a.notBefore).toBe("Potrai iniziare da giovedì 12 novembre.");
    expect(isInWarehouse(legs, after)).toBe(true);
    expect(isInWarehouse(legs, steps)).toBe(false);
    expect(isInWarehouse(legs, [...after, ...rec(1, "arrived_pickup")])).toBe(false);
    // early start allowed by the admin (admin_allow_early_start)
    expect(nextAction({ status: "in_transit", legs: [leg(0, TODAY), leg(1, TOMORROW, { earlyStartAllowedAt: TODAY })], steps: after, now: NOW })).toMatchObject({ legIndex: 1, notBefore: null });
  });

  it("pickup day in Rome, not UTC; leg 0 free once the admin moved past assigned", () => {
    // 23:30 UTC on the 11th = 00:30 in Rome on the 12th
    const lateNight = new Date("2026-11-11T23:30:00Z");
    expect(nextAction({ status: "assigned", legs: [leg(0, TOMORROW)], steps: [], now: lateNight })).toMatchObject({ notBefore: null });
    expect(nextAction({ status: "assigned", legs: [leg(0, TOMORROW)], steps: [], now: NOW })).toMatchObject({ notBefore: expect.stringContaining("12 novembre") });
    expect(nextAction({ status: "picked_up", legs: [leg(0, TOMORROW)], steps: [], now: NOW })).toMatchObject({ notBefore: null });
  });

  it("nothing when the job is not running", () => {
    for (const status of ["paid", "delivered", "completed", "cancelled"]) {
      expect(nextAction({ status, legs: [leg(0, TODAY)], steps: [], now: NOW })).toEqual({ kind: "none" });
    }
  });
});

describe("labels", () => {
  it("photos only for loaded / unloaded; warehouse wording", () => {
    expect(LEG_STEPS.map(photoKindForStep)).toEqual([null, "pickup", null, null, "delivery"]);
    expect(stepButtonLabel("arrived_delivery", { pickupIsWarehouse: false, deliveryIsWarehouse: true })).toBe("Sono arrivato al magazzino");
  });

  it("romeDateKey", () => {
    expect(romeDateKey("2026-11-11T22:59:00Z")).toBe("2026-11-11");
    expect(romeDateKey("2026-11-11T23:00:00Z")).toBe("2026-11-12");
    expect(romeDateKey("2026-07-01T22:00:00Z")).toBe("2026-07-02"); // summer time
  });
});

describe("porter time (D69) — minutes from the database", () => {
  it("formatWorkedMinutes", () => {
    expect([0, 45, 60, 65, 125, -3].map(formatWorkedMinutes)).toEqual(["0 min", "45 min", "1 h", "1 h 05 min", "2 h 05 min", "0 min"]);
  });

  it("overtime hours with the D68 rule (grace, started hours), no amounts; disabled → 0", () => {
    const terms = [{ legIndex: 1, persons: 1, includedHours: 1, graceMinutes: 15 }, { legIndex: 0, persons: 2, includedHours: 3, graceMinutes: 15 }];
    const worked = [{ leg_index: 0, worked_minutes: 196, complete: true }, { leg_index: 1, worked_minutes: 75, complete: true }];
    expect(porterSummaries(terms, worked, true)).toEqual([
      { legIndex: 0, workedMinutes: 196, workedLabel: "3 h 16 min", includedLabel: "3 h", complete: true, overtimeHours: 1 },
      { legIndex: 1, workedMinutes: 75, workedLabel: "1 h 15 min", includedLabel: "1 h", complete: true, overtimeHours: 0 }, // within grace
    ]);
    expect(porterSummaries(terms, worked, false).map((s) => s.overtimeHours)).toEqual([0, 0]);
    expect(porterSummaries(terms, [{ leg_index: 0, worked_minutes: 241, complete: true }], true).map((s) => s.overtimeHours)).toEqual([2, 0]);
    expect(porterSummaries([{ legIndex: 0, persons: 0, includedHours: 1, graceMinutes: 0 }], worked, true)).toEqual([]);
    expect(porterSummaries(terms, [], true).every((s) => !s.complete && s.workedMinutes === 0)).toBe(true);
  });
});

describe("photos and signature", () => {
  it("scaledSize: longer side 1600, ratio kept, never enlarged", () => {
    expect(scaledSize(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(scaledSize(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(scaledSize(16000, 10)).toEqual({ width: 1600, height: 1 });
    expect(scaledSize(0, 100)).toEqual({ width: 0, height: 0 });
  });

  it("paths match what the database accepts", () => {
    expect(photoPath(O, F)).toBe(`${O}/${F}.jpg`);
    expect(isPhotoPath(O, photoPath(O, F))).toBe(true);
    expect(isPhotoPath(O, `${O}/../${F}.jpg`)).toBe(false);
    expect(isPhotoPath(O, `${F}/${F}.jpg`)).toBe(false);
    expect(isSignaturePath(O, signaturePath(O, F))).toBe(true);
    expect(isSignaturePath(O, photoPath(O, F))).toBe(false);
  });

  it("a retried upload that had arrived counts as uploaded", () => {
    expect(isAlreadyUploaded({ statusCode: "409", message: "Duplicate" })).toBe(true);
    expect(isAlreadyUploaded({ message: "The resource already exists" })).toBe(true);
    expect(isAlreadyUploaded({ statusCode: 403, message: "new row violates row-level security policy" })).toBe(false);
    expect(isAlreadyUploaded(null)).toBe(false);
  });

  it("upload errors (codes as the local Storage answers them)", () => {
    expect(uploadErrorMessage(null, "photo")).toBeNull();
    expect(uploadErrorMessage({ statusCode: "409", message: "The resource already exists" }, "photo")).toBeNull();
    expect(uploadErrorMessage({ statusCode: "413", message: "The object exceeded the maximum allowed size" }, "photo"))
      .toEqual({ message: EXEC_MSG.photoTooBig, refresh: false });
    expect(uploadErrorMessage({ statusCode: "413" }, "signature")).toEqual({ message: EXEC_MSG.signature, refresh: false });
    expect(uploadErrorMessage({ statusCode: "403", message: "new row violates row-level security policy" }, "photo"))
      .toEqual({ message: EXEC_MSG.notInProgress, refresh: true });
    expect(uploadErrorMessage({ statusCode: "415" }, "photo")).toEqual({ message: EXEC_MSG.photoInvalid, refresh: false });
    expect(uploadErrorMessage({ name: "StorageUnknownError", message: "fetch failed" }, "photo")).toEqual({ message: EXEC_MSG.network, refresh: false });
  });

  it("recipient name is required", () => {
    expect(recipientNameSchema.safeParse("  ").success).toBe(false);
    expect(recipientNameSchema.safeParse("x".repeat(201)).success).toBe(false);
    expect(recipientNameSchema.parse("  Lucia Bianchi ")).toBe("Lucia Bianchi");
  });
});

describe("executionDbError", () => {
  const e = (code: string, details?: string) => ({ code, details, message: "x" });
  it("maps every database error to Italian, with refresh when the job changed", () => {
    expect(executionDbError(e("55000", "wrong_step:0:loaded"))).toEqual({ message: EXEC_MSG.wrongStep, refresh: true });
    expect(executionDbError(e("55000", "wrong_step:done"))).toEqual({ message: EXEC_MSG.wrongStep, refresh: true });
    expect(executionDbError(e("55000", "not_assigned"))).toEqual({ message: EXEC_MSG.notAssigned, refresh: true });
    expect(executionDbError(e("55000", "not_in_progress")).refresh).toBe(true);
    expect(executionDbError(e("55000", "too_early"))).toEqual({ message: EXEC_MSG.tooEarly, refresh: false });
    expect(executionDbError(e("55000", "photo_required")).message).toBe(EXEC_MSG.photoRequired);
    expect(executionDbError(e("55000", "step_closed"))).toEqual({ message: EXEC_MSG.stepClosed, refresh: true });
    expect(executionDbError(e("55000", "too_many_photos")).message).toBe(EXEC_MSG.tooManyPhotos);
    expect(executionDbError(e("55000", "steps_missing")).refresh).toBe(true);
    expect(executionDbError(e("22023", "file")).message).toBe(EXEC_MSG.photoInvalid);
    expect(executionDbError(e("22023", "path")).message).toBe(EXEC_MSG.photoInvalid);
    expect(executionDbError(e("22023", "recipient_name")).message).toBe(EXEC_MSG.recipientName);
    expect(executionDbError(e("22023", "signature")).message).toBe(EXEC_MSG.signature);
    expect(executionDbError(e("42501")).message).toBe(EXEC_MSG.forbidden);
    expect(executionDbError(e("08006")).message).toBe(EXEC_MSG.generic);
    expect(executionDbError(null).message).toBe(EXEC_MSG.generic);
    // never the database text
    expect(executionDbError({ code: "55000", details: "something new", message: "relation secret" }).message).toBe(EXEC_MSG.generic);
  });
});

describe("porterTimeSuffix", () => {
  it("in corso while the job runs, non misurato once delivered without a measurement", () => {
    expect(porterTimeSuffix(true, "delivered")).toBe("");
    expect(porterTimeSuffix(false, "picked_up")).toBe(" · in corso");
    expect(porterTimeSuffix(false, "delivered")).toBe(" · non misurato");
    expect(porterTimeSuffix(false, "completed")).toBe(" · non misurato");
  });
});
