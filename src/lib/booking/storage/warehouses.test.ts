import { describe, expect, it } from "vitest";
import { searchWarehouses, type PublicWarehouse } from "./warehouses";

const W = (id: string, city: string, province: string, name = `Magazzino ${city}`): PublicWarehouse => ({ id, name, address: `Via ${id} 1, ${city}`, city, province });
const list = [W("b", "Bologna", "BO"), W("m1", "Milano", "MI", "Milano Est"), W("m2", "Milano", "MI", "Milano Ovest"), W("f", "Forlì", "FC")];

describe("searchWarehouses (D178)", () => {
  it("empty query: all, by city then name", () => {
    expect(searchWarehouses(list, "  ").map((w) => w.id)).toEqual(["b", "f", "m1", "m2"]);
  });
  it("by city, case and accents ignored; by province code; by several words", () => {
    expect(searchWarehouses(list, "MILANO").map((w) => w.id)).toEqual(["m1", "m2"]);
    expect(searchWarehouses(list, "forli").map((w) => w.id)).toEqual(["f"]);
    expect(searchWarehouses(list, "bo").map((w) => w.id)).toEqual(["b"]);
    expect(searchWarehouses(list, "milano ovest").map((w) => w.id)).toEqual(["m2"]);
    expect(searchWarehouses(list, "Roma")).toEqual([]);
  });
});
