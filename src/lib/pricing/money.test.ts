import { describe, expect, it } from "vitest";
import { allocateProportionally, applyBp, formatBp, formatCents, mulDivRoundHalfUp, parseEuroToCents, parsePercentToBp } from "./money";

describe("applyBp / mulDivRoundHalfUp (round half up)", () => {
  it.each([
    [1234, 2200, 271], // 271,48
    [1225, 2200, 270], // 269,5 → up
    [1, 5000, 1], // 0,5 → up
    [1, 4999, 0],
    [0, 2200, 0],
    [4500, 3000, 1350],
  ])("%i × %i bp → %i", (amount, bp, expected) => {
    expect(applyBp(amount, bp)).toBe(expected);
  });

  it("is exact for large amounts (no float error)", () => {
    expect(mulDivRoundHalfUp(9_007_199_254_740_991, 3, 3)).toBe(9_007_199_254_740_991);
    expect(applyBp(100_000_000_00, 2200)).toBe(2_200_000_000);
  });

  it("rejects negative or fractional input", () => {
    expect(() => applyBp(-1, 2200)).toThrow(RangeError);
    expect(() => applyBp(1.5, 2200)).toThrow(RangeError);
  });
});

describe("allocateProportionally (largest remainder)", () => {
  it("parts always sum to the total", () => {
    for (const [total, weights] of [
      [2, [3, 3, 3]],
      [100, [1, 1, 1]],
      [7075, [20_160, 12_000]],
      [1, [5, 5]],
      [0, [5, 5]],
    ] as const) {
      const parts = allocateProportionally(total, [...weights]);
      expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
    }
  });
  it("ties go to the earlier index", () => {
    expect(allocateProportionally(2, [3, 3, 3])).toEqual([1, 1, 0]);
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });
  it("largest remainder wins", () => {
    expect(allocateProportionally(10, [1, 2])).toEqual([3, 7]); // 3,33 / 6,67
  });
  it("all-zero weights → everything to the first part", () => {
    expect(allocateProportionally(500, [0, 0])).toEqual([500, 0]);
  });
});

describe("parsing admin input without floats", () => {
  it.each([
    ["1,20", 120],
    ["0.9", 90],
    ["15", 1500],
    ["1.234,50", 123_450],
    ["  12,5 € ", 1250],
  ])("euro %s → %i cents", (input, cents) => {
    expect(parseEuroToCents(input)).toBe(cents);
  });
  it.each(["", "abc", "1,234", "-5", "1,2,3"])("rejects euro %s", (input) => {
    expect(parseEuroToCents(input)).toBeNull();
  });
  it.each([
    ["70", 7000],
    ["12,5", 1250],
    ["0.25", 25],
    ["22 %", 2200],
  ])("percent %s → %i bp", (input, bp) => {
    expect(parsePercentToBp(input)).toBe(bp);
  });
  it("rejects bad percents", () => {
    expect(parsePercentToBp("1,234")).toBeNull();
    expect(parsePercentToBp("x")).toBeNull();
  });
});

describe("formatting", () => {
  it("formats cents and bp the Italian way", () => {
    expect(formatCents(39_235)).toBe("392,35 €");
    expect(formatCents(123_456_7)).toBe("12.345,67 €");
    expect(formatBp(2200)).toBe("22");
    expect(formatBp(1250)).toBe("12,5");
    expect(formatBp(25)).toBe("0,25");
  });
});
