import { describe, expect, it } from "vitest";
import { bookingEntries, bookingGroupRoots, occupancy } from "./storage-bookings";

const booking = (o: { intake?: string; outbound?: string } = {}) => ({
  pallets: null as number | null,
  start_date: "2026-11-20", end_date: "2026-12-19", intake: "transigo", outbound: "transigo", status: "booked",
  unit: "box", box_code: "m" as string | null, warehouse_id: "w1", ...o,
});
type B = ReturnType<typeof booking>;
const order = (id: string, o: { service_type?: string; status?: string; parent_order_id?: string; warehouse_bookings?: B | null } = {}) => ({
  id, order_number: `TG-${id}`, parent_order_id: null as string | null, created_at: "2026-11-12T10:00:00Z", service_type: "transport", status: "paid",
  warehouse_bookings: null as B | null, ...o,
});

describe("bookingEntries", () => {
  it("joins the chain's transports: phase from the intake and the delivery", () => {
    const storage = [order("st", { service_type: "storage", parent_order_id: "in", warehouse_bookings: booking() })];
    const related = [order("in", { status: "delivered" }), order("out", { parent_order_id: "in", status: "assigned" }), order("other")];
    expect(bookingGroupRoots(storage)).toEqual(["in"]);
    const [e] = bookingEntries(storage, related, "2026-11-25");
    expect(e.phase).toBe("stored");
    expect(e.members.map((m) => [m.id, m.role])).toEqual([["in", "intake"], ["st", "storage"], ["out", "outbound"]]);
  });

  it("a storage order alone (porto io) and one whose root is missing; no booking → skipped", () => {
    const alone = order("a", { service_type: "storage", warehouse_bookings: booking({ intake: "self", outbound: "self" }) });
    const orphan = order("b", { service_type: "storage", parent_order_id: "gone", warehouse_bookings: booking({ intake: "self", outbound: "self" }) });
    const none = order("c", { service_type: "storage", warehouse_bookings: null });
    const entries = bookingEntries([alone, orphan, none], [], "2026-11-25");
    expect(entries.map((e) => [e.order.id, e.phase, e.members.length])).toEqual([["a", "stored", 1], ["b", "stored", 1]]);
  });
});

describe("occupancy", () => {
  it("counts boxes per size and pallets of the goods inside (stored or ended)", () => {
    const b = (phase: string, x: Record<string, unknown>) => ({ phase: phase as never, booking: { unit: "box", box_code: null, pallets: null, ...x } as never });
    expect(occupancy([
      b("stored", { box_code: "m" }), b("ended", { box_code: "m" }), b("booked", { box_code: "l" }),
      b("stored", { unit: "pallet", pallets: 4 }), b("left", { unit: "pallet", pallets: 9 }),
    ])).toEqual({ boxes: { m: 2 }, pallets: 4 });
  });
});
