import { describe, expect, it } from "vitest";
import { CUSTOMER_STATUS_LABEL, customerListEntries, orderGroup, orderTitle, progressSteps, routeSummary, statusTone } from "./customer-view";
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

describe("orderTitle (D151)", () => {
  const leg = { leg_index: 0, pickup_city: "Milano", delivery_city: "Torino" };
  it("transport: the route (also for orders without service_type, before D151)", () => {
    expect(orderTitle({ service_type: "transport", order_legs: [leg] })).toBe("Milano → Torino");
    expect(orderTitle({ order_legs: [leg] })).toBe("Milano → Torino");
  });
  it("porters and storage have no legs: the city of the job / the booked space", () => {
    expect(orderTitle({ service_type: "porters", order_legs: [], order_porter_jobs: { city: "Firenze" } })).toBe("Facchinaggio · Firenze");
    expect(orderTitle({ service_type: "storage", order_legs: [], warehouse_bookings: { unit: "box", box_code: "m", pallets: null } })).toBe("Deposito · Box M");
    expect(orderTitle({ service_type: "storage", order_legs: [], warehouse_bookings: { unit: "pallet", box_code: null, pallets: 4 } })).toBe("Deposito · 4 pallet");
  });
  it("never crashes without the job or the booking", () => {
    expect(orderTitle({ service_type: "porters", order_legs: [], order_porter_jobs: null })).toBe("Facchinaggio");
    expect(orderTitle({ service_type: "storage", order_legs: [] })).toBe("Deposito");
  });
});

describe("customerListEntries", () => {
  const row = (id: string, o: Partial<import("./customer-view").ListRow> = {}) => ({
    id, order_number: `TG-${id}`, service_type: "transport", parent_order_id: null, status: "paid",
    created_at: "2026-11-12T10:00:00Z", pickup_window_start: "2026-11-20T09:00:00Z",
    order_charges: { total_cents: 1000, refunded_cents: 0 }, ...o,
  });

  it("a chain is one entry: root first, storage, then the delivery; totals summed", () => {
    const rows = [
      row("out", { parent_order_id: "in", pickup_window_start: "2026-12-30T09:00:00Z", order_charges: { total_cents: 300, refunded_cents: 0 } }),
      row("st", { parent_order_id: "in", service_type: "storage", order_charges: { total_cents: 200, refunded_cents: 50 } }),
      row("in", { pickup_window_start: "2026-11-15T09:00:00Z" }),
      row("solo"),
    ];
    const entries = customerListEntries(rows);
    expect(entries).toHaveLength(2);
    const chain = entries.find((e) => e.root.id === "in")!;
    expect(chain.members.map((m) => [m.id, m.role])).toEqual([["in", "intake"], ["st", "storage"], ["out", "outbound"]]);
    expect(chain.totalCents).toBe(1500);
    expect(chain.refundedCents).toBe(50);
    expect(chain.startsAt).toBe("2026-11-15T09:00:00Z");
    expect(entries.find((e) => e.root.id === "solo")!.members.map((m) => m.role)).toEqual([null]);
  });

  it("the group stays 'In corso' until every order is finished", () => {
    const rows = [row("in", { status: "delivered" }), row("st", { parent_order_id: "in", service_type: "storage" })];
    expect(customerListEntries(rows)[0].tab).toBe("active");
    expect(customerListEntries(rows.map((r) => ({ ...r, status: "delivered" })))[0].tab).toBe("finished");
  });

  it("a child without its root among the rows is shown on its own; missing charges → no total", () => {
    const [e] = customerListEntries([row("x", { parent_order_id: "missing", order_charges: null })]);
    expect(e.root.id).toBe("x");
    expect(e.totalCents).toBeNull();
  });
});
