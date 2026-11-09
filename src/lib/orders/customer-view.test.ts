import { describe, expect, it } from "vitest";
import { CUSTOMER_STATUS_LABEL, orderGroup, progressSteps, routeSummary, statusTone } from "./customer-view";
import { ORDER_STATUS_LABEL } from "./status";

const base = { paid_at: "2026-11-09T08:00:00Z", assigned_at: null, picked_up_at: null, in_transit_at: null, delivered_at: null };

describe("orderGroup", () => {
  it("finished: delivered, completed, cancelled, refunded, expired; everything else is in progress", () => {
    for (const s of ["delivered", "completed", "cancelled", "refunded", "expired"]) expect(orderGroup(s)).toBe("finished");
    for (const s of ["pending_payment", "payment_review", "paid", "assigned", "picked_up", "in_transit", "cancellation_review"]) expect(orderGroup(s)).toBe("active");
  });
});

describe("labels and tones", () => {
  it("every order status has a customer label and a tone", () => {
    for (const s of Object.keys(ORDER_STATUS_LABEL)) {
      expect(CUSTOMER_STATUS_LABEL[s]).toBeTruthy();
      expect(statusTone(s)).toBeTruthy();
    }
    expect(CUSTOMER_STATUS_LABEL.assigned).toBe("Trasportatore assegnato");
  });
});

describe("progressSteps", () => {
  it("paid: first step current, nothing else", () => {
    const p = progressSteps({ ...base, status: "paid" })!;
    expect(p.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo", "todo"]);
    expect(p[0].at).toBe(base.paid_at);
  });

  it("in transit: earlier steps done with their times", () => {
    const p = progressSteps({ ...base, status: "in_transit", assigned_at: "a", picked_up_at: "b", in_transit_at: "c" })!;
    expect(p.map((s) => s.state)).toEqual(["done", "done", "done", "current", "todo"]);
    expect(p.map((s) => s.at)).toEqual([base.paid_at, "a", "b", "c", null]);
  });

  it("delivered and completed: all done", () => {
    for (const status of ["delivered", "completed"]) {
      expect(progressSteps({ ...base, status, delivered_at: "d" })!.every((s) => s.state === "done")).toBe(true);
    }
  });

  it("no bar for orders that are not on the delivery path", () => {
    for (const status of ["pending_payment", "payment_review", "expired", "cancelled", "refunded", "cancellation_review"]) {
      expect(progressSteps({ ...base, status })).toBeNull();
    }
  });
});

describe("routeSummary", () => {
  it("one leg, two legs (storage), none", () => {
    expect(routeSummary([{ leg_index: 0, pickup_city: "Milano", delivery_city: "Torino" }])).toBe("Milano → Torino");
    expect(routeSummary([
      { leg_index: 1, pickup_city: "Milano", delivery_city: "Bergamo" },
      { leg_index: 0, pickup_city: "Como", delivery_city: "Milano" },
    ])).toBe("Como → Bergamo (con deposito)");
    expect(routeSummary([])).toBe("—");
  });
});
