import { describe, expect, it } from "vitest";
import { cancellationPreview, freeCancellationUntil, groupCancellationPreview, lateCancellationFeeCents, refundStatusFromStripe, type CancellationInput } from "./cancellation";

const H = 3_600_000;
const lines = [
  { line_type: "transport", gross_cents: 12_200 },
  { line_type: "porters", gross_cents: 7_320 },
];
const withStorage = [...lines, { line_type: "transport", gross_cents: 12_200 }, { line_type: "porters", gross_cents: 7_320 }, { line_type: "storage", gross_cents: 4_270 }];

const pickup = new Date("2026-12-01T09:00:00Z");
const base: CancellationInput = {
  status: "paid", pickupWindowStart: pickup, now: new Date(pickup.getTime() - 72 * H), freeHours: 24, feeBp: 5000,
  totalCents: 19_520, refundedCents: 0, lines,
};

describe("lateCancellationFeeCents (D38)", () => {
  it("50 % of transport + porters, storage excluded", () => {
    expect(lateCancellationFeeCents(lines, 5000)).toBe(9_760);
    expect(lateCancellationFeeCents(withStorage, 5000)).toBe(19_520);
  });

  it("rounds half up to the cent", () => {
    // 1 cent × 50 % = 0.5 → 1;  3 cents × 50 % = 1.5 → 2;  19 520 × 33.33 % = 6 506.016 → 6 506
    expect(lateCancellationFeeCents([{ line_type: "transport", gross_cents: 1 }], 5000)).toBe(1);
    expect(lateCancellationFeeCents([{ line_type: "transport", gross_cents: 3 }], 5000)).toBe(2);
    expect(lateCancellationFeeCents(lines, 3333)).toBe(6_506);
    expect(lateCancellationFeeCents([{ line_type: "transport", gross_cents: 9_999 }], 1)).toBe(1); // 0.9999 → 1
    expect(lateCancellationFeeCents([{ line_type: "transport", gross_cents: 4_999 }], 1)).toBe(0); // 0.4999 → 0
  });

  it("0 % and 100 %", () => {
    expect(lateCancellationFeeCents(withStorage, 0)).toBe(0);
    expect(lateCancellationFeeCents(withStorage, 10_000)).toBe(39_040);
  });

  it("refuses an invalid rate", () => {
    expect(() => lateCancellationFeeCents(lines, -1)).toThrow();
    expect(() => lateCancellationFeeCents(lines, 10_001)).toThrow();
    expect(() => lateCancellationFeeCents(lines, 12.5)).toThrow();
  });
});

describe("cancellationPreview (D33)", () => {
  it("free before the deadline: full refund", () => {
    expect(cancellationPreview(base)).toEqual({ kind: "free", feeCents: 0, refundCents: 19_520, freeUntil: new Date(pickup.getTime() - 24 * H), basis: "pickup" });
  });

  it("the deadline itself is already late (same comparison as the database)", () => {
    const at = freeCancellationUntil(pickup, 24);
    expect(cancellationPreview({ ...base, now: new Date(at.getTime() - 1) }).kind).toBe("free");
    expect(cancellationPreview({ ...base, now: at })).toMatchObject({ kind: "late", feeCents: 9_760, refundCents: 9_760 });
  });

  it("late with storage: storage refunded in full", () => {
    const r = cancellationPreview({ ...base, now: new Date(pickup.getTime() - 2 * H), totalCents: 43_310, lines: withStorage });
    expect(r).toMatchObject({ kind: "late", feeCents: 19_520, refundCents: 23_790 });
  });

  it("refunds already made reduce the refund, never below zero", () => {
    expect(cancellationPreview({ ...base, refundedCents: 1_000 })).toMatchObject({ refundCents: 18_520 });
    expect(cancellationPreview({ ...base, now: pickup, refundedCents: 19_000 })).toMatchObject({ feeCents: 9_760, refundCents: 0 });
  });

  it("assigned → review; anything else → not allowed", () => {
    expect(cancellationPreview({ ...base, status: "assigned" })).toEqual({ kind: "review" });
    for (const status of ["pending_payment", "picked_up", "in_transit", "delivered", "cancelled", "cancellation_review", "expired"]) {
      expect(cancellationPreview({ ...base, status })).toEqual({ kind: "not_allowed" });
    }
  });
});

describe("storage (D170) and storage chains (D169)", () => {
  const start = new Date("2026-12-01T23:00:00Z"); // 00:00 Europe/Rome of 2 December
  const storage: CancellationInput = { ...base, serviceType: "storage", pickupWindowStart: start, totalCents: 7_320, lines: [{ line_type: "storage", gross_cents: 7_320 }] };

  it("storage: free with a full refund until it starts, whatever freeHours; from the start no cancellation", () => {
    expect(cancellationPreview({ ...storage, now: new Date(start.getTime() - H) })).toEqual({ kind: "free", feeCents: 0, refundCents: 7_320, freeUntil: start, basis: "storage" });
    expect(cancellationPreview({ ...storage, now: start })).toEqual({ kind: "not_allowed" });
  });

  it("chain: sums per order; the D33 fee only on the late transport; the earliest free deadline is shown", () => {
    const now = new Date(pickup.getTime() - 12 * H); // intake late; storage starts later; outbound far away
    const intake = { ...base, now };
    const st = { ...storage, now, pickupWindowStart: new Date(pickup.getTime() + 14 * H) };
    const outbound = { ...base, now, pickupWindowStart: new Date(pickup.getTime() + 40 * 24 * H) };
    expect(groupCancellationPreview([intake, st, outbound])).toEqual({
      kind: "late", feeCents: 9_760, refundCents: 9_760 + 7_320 + 19_520, freeUntil: st.pickupWindowStart, basis: "storage",
    });
  });

  it("chain: a carrier on any order or the storage started → no cancellation from the app", () => {
    expect(groupCancellationPreview([base, { ...base, status: "assigned" }])).toEqual({ kind: "not_allowed" });
    expect(groupCancellationPreview([base, { ...storage, now: start }])).toEqual({ kind: "not_allowed" });
    expect(groupCancellationPreview([base])).toEqual(cancellationPreview(base));
  });
});

describe("refundStatusFromStripe", () => {
  it("maps the Stripe refund statuses", () => {
    expect(refundStatusFromStripe("succeeded")).toBe("succeeded");
    expect(refundStatusFromStripe("failed")).toBe("failed");
    expect(refundStatusFromStripe("canceled")).toBe("failed");
    for (const s of ["pending", "requires_action", null, undefined, "something_new"]) expect(refundStatusFromStripe(s)).toBe("pending");
  });
});
