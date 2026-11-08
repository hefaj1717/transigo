import { describe, expect, it } from "vitest";
import { isWeekendOrHoliday, romeDate, romeLocalToDate } from "./calendar";

describe("calendar (Europe/Rome)", () => {
  it("romeDate uses Italian local date", () => {
    expect(romeDate(new Date("2026-11-13T23:30:00Z"))).toEqual({ date: "2026-11-14", weekday: "Sat" });
    expect(romeDate(new Date("2026-07-31T22:30:00Z"))).toEqual({ date: "2026-08-01", weekday: "Sat" }); // CEST
  });
  it("isWeekendOrHoliday", () => {
    const holidays = new Set(["2026-12-08"]);
    expect(isWeekendOrHoliday(new Date("2026-12-08T10:00:00Z"), holidays)).toBe(true);
    expect(isWeekendOrHoliday(new Date("2026-12-09T10:00:00Z"), holidays)).toBe(false);
  });
  it("romeLocalToDate converts winter and summer local times", () => {
    expect(romeLocalToDate("2026-11-14T09:00")?.toISOString()).toBe("2026-11-14T08:00:00.000Z");
    expect(romeLocalToDate("2026-07-01T09:00")?.toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(romeLocalToDate("2026-03-29T12:00")?.toISOString()).toBe("2026-03-29T10:00:00.000Z"); // DST day
    expect(romeLocalToDate("bad")).toBeNull();
  });
});
