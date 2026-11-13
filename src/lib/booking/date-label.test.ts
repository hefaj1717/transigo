import { describe, expect, it } from "vitest";
import { bookingDateLabel } from "./date-label";

describe("bookingDateLabel", () => {
  it("formats an ISO day in Italian", () => {
    expect(bookingDateLabel("2026-11-18")).toBe("18 novembre 2026");
    expect(bookingDateLabel("2026-11-18", { weekday: true })).toBe("mercoledì 18 novembre 2026");
  });
  it("returns an empty string for missing or malformed input", () => {
    expect(bookingDateLabel(null)).toBe("");
    expect(bookingDateLabel("")).toBe("");
    expect(bookingDateLabel("18/11/2026")).toBe("");
  });
});
