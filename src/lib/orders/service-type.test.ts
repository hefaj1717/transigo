import { describe, expect, it } from "vitest";
import { bookingDays, bookingUnitLabel, dispatchable, formatDateOnly, serviceFilter, serviceTypeOf } from "./service-type";

describe("serviceTypeOf", () => {
  it("known codes pass, anything else is transport (orders before D151)", () => {
    expect(serviceTypeOf("porters")).toBe("porters");
    expect(serviceTypeOf("storage")).toBe("storage");
    expect(serviceTypeOf("transport")).toBe("transport");
    expect(serviceTypeOf(undefined)).toBe("transport");
    expect(serviceTypeOf("something")).toBe("transport");
  });
});

describe("serviceFilter", () => {
  it("maps the Italian key to the type; unknown or missing = all", () => {
    expect(serviceFilter("facchinaggio").type).toBe("porters");
    expect(serviceFilter("deposito").type).toBe("storage");
    expect(serviceFilter("trasporto").type).toBe("transport");
    expect(serviceFilter(["deposito", "trasporto"]).type).toBe("storage");
    expect(serviceFilter(undefined)).toMatchObject({ key: "tutti", type: null });
    expect(serviceFilter("storage")).toMatchObject({ key: "tutti", type: null }); // codes are not URL keys
  });
});

describe("storage helpers", () => {
  it("days are inclusive, also across the DST change", () => {
    expect(bookingDays("2026-11-12", "2026-11-12")).toBe(1);
    expect(bookingDays("2026-11-12", "2026-12-11")).toBe(30);
    expect(bookingDays("2027-03-27", "2027-03-29")).toBe(3);
  });

  it("unit label and date", () => {
    expect(bookingUnitLabel({ unit: "box", box_code: "m", pallets: null })).toBe("Box M");
    expect(bookingUnitLabel({ unit: "pallet", box_code: null, pallets: 3 })).toBe("3 pallet");
    expect(formatDateOnly("2026-11-05")).toBe("05/11/2026");
  });

  it("storage is never dispatched to carriers", () => {
    expect(dispatchable("storage")).toBe(false);
    expect(dispatchable("porters")).toBe(true);
    expect(dispatchable("transport")).toBe(true);
  });
});
