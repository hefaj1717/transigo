import { describe, expect, it } from "vitest";
import { expiringDocuments, monthFinance, romeMidnight, romeMonthRange, unassignedTooLong, type FinanceOrder } from "./dashboard";

describe("months in Europe/Rome", () => {
  it("midnight in winter (UTC+1) and summer (UTC+2)", () => {
    expect(romeMidnight(2026, 11).toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(romeMidnight(2026, 7).toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(romeMidnight(2026, 3, 29).toISOString()).toBe("2026-03-28T23:00:00.000Z"); // DST day: midnight still UTC+1
  });

  it("current month by default; a valid past month; future or garbage → current", () => {
    const now = new Date("2026-11-30T23:30:00Z"); // already 1 December in Rome
    expect(romeMonthRange(undefined, now)).toMatchObject({ key: "2026-12", label: "dicembre 2026", prev: "2026-11", next: null });
    const oct = romeMonthRange("2026-10", now);
    expect(oct).toMatchObject({ key: "2026-10", prev: "2026-09", next: "2026-11" });
    expect(oct.start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(oct.end.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(romeMonthRange("2027-01", now).key).toBe("2026-12");
    expect(romeMonthRange("2026-13", now).key).toBe("2026-12");
    expect(romeMonthRange("x),or(", now).key).toBe("2026-12");
    expect(romeMonthRange("2026-01", now)).toMatchObject({ prev: "2025-12" });
  });
});

describe("monthFinance", () => {
  const o = (over: Partial<FinanceOrder>): FinanceOrder => ({ status: "delivered", total_cents: 12_200, subtotal_cents: 10_000, refunded_cents: 0, carrier_amount_cents: 7_000, cancellation_carrier_cents: null, ...over });

  it("gross, net without VAT, expected carrier amount, margin", () => {
    expect(monthFinance([o({}), o({ status: "paid" })])).toEqual({ orders: 2, grossCents: 24_400, netCents: 20_000, carrierCents: 14_000, marginCents: 6_000, refundedCents: 0 });
  });

  it("refunds reduce gross and net proportionally (half up); cancelled orders count only the decided carrier amount", () => {
    // gross 12 200 − 5 000 = 7 200 → net 10 000 × 7 200 / 12 200 = 5 901.6… → 5 902
    expect(monthFinance([o({ refunded_cents: 5_000 })])).toMatchObject({ grossCents: 7_200, netCents: 5_902, refundedCents: 5_000 });
    expect(monthFinance([o({ status: "cancelled", refunded_cents: 12_200, cancellation_carrier_cents: 1_000 })])).toMatchObject({ grossCents: 0, netCents: 0, carrierCents: 1_000, marginCents: -1_000 });
    expect(monthFinance([o({ status: "refunded", refunded_cents: 12_200 })]).carrierCents).toBe(0);
  });

  it("payment_review / unpaid orders do not count", () => {
    expect(monthFinance([o({ status: "payment_review" }), o({ status: "expired" })]).orders).toBe(0);
  });
});

describe("expiringDocuments", () => {
  const now = new Date("2026-11-11T10:00:00Z");
  const d = (over: object) => ({ carrier_id: "c1", vehicle_id: null, doc_type: "insurance", expires_at: "2026-11-30", review_status: "approved", created_at: "2026-01-01T00:00:00Z", ...over });

  it("within 30 days, newest non-rejected per carrier / vehicle / type", () => {
    expect(expiringDocuments([d({})], now)).toHaveLength(1);
    expect(expiringDocuments([d({ expires_at: "2026-12-11" })], now)).toHaveLength(1); // day 30 inclusive
    expect(expiringDocuments([d({ expires_at: "2026-12-12" })], now)).toHaveLength(0);
    expect(expiringDocuments([d({ expires_at: "2026-11-10" })], now)).toHaveLength(0); // already expired: other queue
    expect(expiringDocuments([d({}), d({ expires_at: "2027-11-30", created_at: "2026-11-01T00:00:00Z" })], now)).toHaveLength(0);
    expect(expiringDocuments([d({}), d({ expires_at: "2027-11-30", created_at: "2026-11-01T00:00:00Z", review_status: "rejected" })], now)).toHaveLength(1);
    expect(expiringDocuments([d({}), d({ vehicle_id: "v1" })], now)).toHaveLength(2);
  });
});

describe("unassignedTooLong", () => {
  it("paid, no carrier, paid at least N hours ago", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    expect(unassignedTooLong([
      { status: "paid", carrier_id: null, paid_at: "2026-11-11T08:00:00Z" },
      { status: "paid", carrier_id: null, paid_at: "2026-11-11T09:00:01Z" },
      { status: "paid", carrier_id: "x", paid_at: "2026-11-10T08:00:00Z" },
      { status: "assigned", carrier_id: null, paid_at: "2026-11-10T08:00:00Z" },
    ], 4, now)).toBe(1);
  });
});
