import { describe, expect, it } from "vitest";
import { advanceSchema, assignSchema, DISPATCH_MSG, dispatchDbError, handoverSchema, isHandoverPending, NEXT_STATUS, ORDER_FILTERS, unassignSchema, UNASSIGN_REASONS } from "./dispatch";

const O = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const V = "33333333-3333-4333-8333-333333333333";

describe("NEXT_STATUS (D122)", () => {
  it("one step forward from assigned to delivered; nothing after", () => {
    expect(NEXT_STATUS.assigned?.to).toBe("picked_up");
    expect(NEXT_STATUS.picked_up?.to).toBe("in_transit");
    expect(NEXT_STATUS.in_transit?.to).toBe("delivered");
    for (const s of ["paid", "delivered", "completed", "cancelled"]) expect(NEXT_STATUS[s]).toBeUndefined();
  });
});

describe("forms", () => {
  it("assign: carrier and vehicle from one value", () => {
    expect(assignSchema.parse({ orderId: O, candidate: `${C}:${V}` })).toEqual({ orderId: O, candidate: { carrierId: C, vehicleId: V } });
    expect(assignSchema.safeParse({ orderId: O, candidate: "" }).success).toBe(false);
    expect(assignSchema.safeParse({ orderId: O, candidate: `${C}:x` }).success).toBe(false);
  });
  it("unassign: only the listed reason codes (same list as the database)", () => {
    expect(UNASSIGN_REASONS.map((r) => r.code)).toEqual(["errore_admin", "richiesta_padroncino", "problema_veicolo", "padroncino_non_disponibile", "altro"]);
    expect(unassignSchema.safeParse({ orderId: O, reason: "altro" }).success).toBe(true);
    expect(unassignSchema.safeParse({ orderId: O, reason: "il cliente ha chiamato" }).success).toBe(false);
  });
  it("advance: only forward targets", () => {
    expect(advanceSchema.safeParse({ orderId: O, to: "picked_up" }).success).toBe(true);
    // delivered without POD needs a reason (2026-11-11)
    expect(advanceSchema.safeParse({ orderId: O, to: "delivered" }).success).toBe(false);
    expect(advanceSchema.safeParse({ orderId: O, to: "delivered", note: "   " }).success).toBe(false);
    expect(advanceSchema.safeParse({ orderId: O, to: "delivered", note: "x".repeat(1001) }).success).toBe(false);
    expect(advanceSchema.safeParse({ orderId: O, to: "delivered", note: " Portiere " }).data).toEqual({ orderId: O, to: "delivered", note: "Portiere" });
    expect(advanceSchema.safeParse({ orderId: O, to: "paid" }).success).toBe(false);
  });
});

describe("dispatchDbError", () => {
  it("maps database details to messages", () => {
    expect(dispatchDbError({ code: "55000", details: "already_taken" })).toBe(DISPATCH_MSG.alreadyTaken);
    expect(dispatchDbError({ code: "55000", details: "carrier_not_eligible:document:driving_license" })).toBe(DISPATCH_MSG.carrierNotEligible);
    expect(dispatchDbError({ code: "55000", details: "vehicle_not_suitable" })).toBe(DISPATCH_MSG.vehicleNotSuitable);
    expect(dispatchDbError({ code: "55000", details: "picked_up" })).toBe(DISPATCH_MSG.notNextStatus);
    expect(dispatchDbError({ code: "22023", details: "reason" })).toBe(DISPATCH_MSG.chooseReason);
    expect(dispatchDbError({ code: "22023", details: "note" })).toBe(DISPATCH_MSG.noteRequired);
    expect(dispatchDbError({ code: "42501" })).toBe(DISPATCH_MSG.forbidden);
    expect(dispatchDbError(null)).toBe(DISPATCH_MSG.generic);
  });
});

describe("da gestire (handover)", () => {
  const C = "7d0e6f3a-1b2c-4d5e-8f90-a1b2c3d4e5f6";
  const V = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  it("isHandoverPending only with the flag, no carrier and a running status", () => {
    const base = { handover_required_at: "2026-11-11T10:00:00Z", carrier_id: null, status: "picked_up" };
    expect(isHandoverPending(base)).toBe(true);
    expect(isHandoverPending({ ...base, status: "in_transit" })).toBe(true);
    expect(isHandoverPending({ ...base, status: "delivered" })).toBe(false);
    expect(isHandoverPending({ ...base, carrier_id: C })).toBe(false);
    expect(isHandoverPending({ ...base, handover_required_at: null })).toBe(false);
    expect(ORDER_FILTERS.find((f) => f.key === "da-gestire")).toMatchObject({ handover: true, unassigned: true });
  });
  it("handoverSchema: candidate, address and reason required (trimmed, limits)", () => {
    const ok = { orderId: C, candidate: `${C}:${V}`, address: " Via X 1 ", reason: " Panne " };
    expect(handoverSchema.parse(ok)).toEqual({ orderId: C, candidate: { carrierId: C, vehicleId: V }, address: "Via X 1", reason: "Panne" });
    expect(handoverSchema.safeParse({ ...ok, address: "  " }).success).toBe(false);
    expect(handoverSchema.safeParse({ ...ok, address: "x".repeat(501) }).success).toBe(false);
    expect(handoverSchema.safeParse({ ...ok, reason: "" }).success).toBe(false);
    expect(handoverSchema.safeParse({ ...ok, candidate: "x" }).success).toBe(false);
  });
  it("database errors", () => {
    expect(dispatchDbError({ code: "55000", details: "not_handover" })).toBe(DISPATCH_MSG.notHandover);
    expect(dispatchDbError({ code: "22023", details: "address" })).toBe(DISPATCH_MSG.addressRequired);
  });
});

