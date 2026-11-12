import { describe, expect, it } from "vitest";
import { bookingPhase, BOOKING_PHASE_LABEL, groupBookingPhase, BOOKING_PHASE_TONE, isOpenBookingPhase, romeToday, type BookingPhaseInput } from "./booking-phase";

const booking = { start_date: "2026-11-20", end_date: "2026-12-19", intake: "self", outbound: "self", status: "booked" };
const at = (today: string, o: Partial<BookingPhaseInput> = {}, b: Partial<typeof booking> = {}) =>
  bookingPhase({ orderStatus: "paid", booking: { ...booking, ...b }, today, ...o });

describe("bookingPhase", () => {
  it("unpaid and cancelled come first", () => {
    for (const s of ["pending_payment", "payment_review"]) expect(at("2026-11-25", { orderStatus: s })).toBe("unpaid");
    for (const s of ["cancelled", "refunded", "expired"]) expect(at("2026-11-25", { orderStatus: s })).toBe("cancelled");
    expect(at("2026-11-25", {}, { status: "cancelled" })).toBe("cancelled");
  });

  it("'porto io': booked before the first day, stored during the period, ended after it", () => {
    expect(at("2026-11-19")).toBe("booked");
    expect(at("2026-11-20")).toBe("stored");
    expect(at("2026-12-19")).toBe("stored");
    expect(at("2026-12-20")).toBe("ended");
  });

  it("'ritiro Transigo': follows the intake transport", () => {
    const t = { intake: "transigo" };
    expect(at("2026-11-18", { intakeStatus: "assigned" }, t)).toBe("booked");
    expect(at("2026-11-20", { intakeStatus: "paid" }, t)).toBe("incoming"); // start day, not yet picked up
    expect(at("2026-11-20", { intakeStatus: "in_transit" }, t)).toBe("incoming");
    expect(at("2026-11-20", { intakeStatus: "delivered" }, t)).toBe("stored");
    expect(at("2026-12-21", { intakeStatus: "completed" }, t)).toBe("ended");
  });

  it("'consegna Transigo': left from the pickup at the warehouse", () => {
    const t = { intake: "transigo", outbound: "transigo" };
    expect(at("2026-12-19", { intakeStatus: "delivered", outboundStatus: "assigned" }, t)).toBe("stored");
    expect(at("2026-12-19", { intakeStatus: "delivered", outboundStatus: "picked_up" }, t)).toBe("left");
    expect(at("2026-12-25", { intakeStatus: "delivered", outboundStatus: "delivered" }, t)).toBe("left");
  });

  it("a database status other than 'booked' wins over the dates", () => {
    expect(at("2026-11-01", {}, { status: "in_storage" })).toBe("stored");
    expect(at("2026-12-25", {}, { status: "in_storage" })).toBe("ended");
    expect(at("2026-11-25", {}, { status: "released" })).toBe("left");
  });

  it("labels, tones and open phases cover every phase", () => {
    for (const p of Object.keys(BOOKING_PHASE_LABEL) as (keyof typeof BOOKING_PHASE_LABEL)[]) expect(BOOKING_PHASE_TONE[p]).toBeTruthy();
    expect(["unpaid", "booked", "incoming", "stored"].every((p) => isOpenBookingPhase(p as never))).toBe(true);
    expect(["ended", "left", "cancelled"].some((p) => isOpenBookingPhase(p as never))).toBe(false);
  });

  it("romeToday uses the Italian calendar day", () => {
    expect(romeToday(new Date("2026-11-19T23:30:00Z"))).toBe("2026-11-20");
  });
});

describe("groupBookingPhase", () => {
  it("reads the transports of the chain by their role; null without a booking", () => {
    const b = { ...booking, intake: "transigo", outbound: "transigo" };
    const members = [
      { service_type: "transport", status: "delivered", role: "intake" as const },
      { service_type: "storage", status: "paid", role: "storage" as const, warehouse_bookings: b },
      { service_type: "transport", status: "picked_up", role: "outbound" as const },
    ];
    expect(groupBookingPhase(members, "2026-12-19")).toBe("left");
    expect(groupBookingPhase(members.slice(0, 2), "2026-11-25")).toBe("stored");
    expect(groupBookingPhase([{ service_type: "transport", status: "paid", role: null }], "2026-11-25")).toBeNull();
  });
});
