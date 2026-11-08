import { describe, expect, it } from "vitest";
import { formatDm3AsCubicMetres, parseCubicMetresToDm3 } from "./units";

describe("m³ ↔ dm³ (D81)", () => {
  it("parses Italian and English decimals without floats", () => {
    expect(parseCubicMetresToDm3("9")).toBe(9000);
    expect(parseCubicMetresToDm3("9,5")).toBe(9500);
    expect(parseCubicMetresToDm3("34.5")).toBe(34500);
    expect(parseCubicMetresToDm3(" 1,25 ")).toBe(1250);
    expect(parseCubicMetresToDm3("0,001")).toBe(1);
  });
  it("rejects anything else", () => {
    for (const bad of ["", "9,5555", "-1", "abc", "1,2,3", "9 m3"]) expect(parseCubicMetresToDm3(bad)).toBeNull();
  });
  it("formats back", () => {
    expect([9500, 20000, 1200, 34500, 1].map(formatDm3AsCubicMetres)).toEqual(["9,5", "20", "1,2", "34,5", "0,001"]);
  });
});
