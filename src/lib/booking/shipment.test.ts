import { describe, expect, it } from "vitest";
import { EMPTY_WIZARD_STATE, goodsForCategory, goodsStepError, isStackableCategory, loadNeeds, parseStoredState, type WizardState } from "./state";

const goods = (patch: Partial<WizardState["goods"]>): WizardState["goods"] => ({
  ...EMPTY_WIZARD_STATE.goods,
  description: "Merce",
  itemsCount: 5,
  weightKg: 300,
  palletsCount: 2,
  largestItem: { lengthCm: 120, widthCm: 80, heightCm: 100 },
  loadCategory: "bilocale",
  stackable: true,
  ...patch,
});

describe("shipment category (D176)", () => {
  it("keeps only the fields each category asks for", () => {
    expect(goodsForCategory(goods({ shipmentCategory: "pallet" }))).toMatchObject({ palletsCount: 2, itemsCount: null, weightKg: 300, largestItem: { lengthCm: null }, stackable: true, loadCategory: null });
    expect(goodsForCategory(goods({ shipmentCategory: "gitterbox" }))).toMatchObject({ palletsCount: 2, itemsCount: null, stackable: true });
    expect(goodsForCategory(goods({ shipmentCategory: "package" }))).toMatchObject({ palletsCount: null, itemsCount: 5, weightKg: 300, largestItem: { lengthCm: 120 }, stackable: true });
    expect(goodsForCategory(goods({ shipmentCategory: "document" }))).toMatchObject({ palletsCount: null, itemsCount: 5, weightKg: null, largestItem: { lengthCm: null }, stackable: false });
    expect(goodsForCategory(goods({ shipmentCategory: "full_vehicle" }))).toMatchObject({ palletsCount: null, itemsCount: null, weightKg: null, largestItem: { lengthCm: null }, stackable: false });
  });

  it("only pallet, package and gitterbox can be stackable", () => {
    expect(["pallet", "package", "gitterbox"].every((c) => isStackableCategory(c as never))).toBe(true);
    expect(isStackableCategory("document")).toBe(false);
    expect(isStackableCategory("full_vehicle")).toBe(false);
    expect(isStackableCategory(null)).toBe(false);
  });

  it("step errors: category first, then its count, then the description", () => {
    expect(goodsStepError(goods({ shipmentCategory: null }))).toMatch(/Scegli/);
    expect(goodsStepError(goods({ shipmentCategory: "pallet", palletsCount: null }))).toMatch(/pallet/);
    expect(goodsStepError(goods({ shipmentCategory: "gitterbox", palletsCount: null }))).toMatch(/gitterbox/);
    expect(goodsStepError(goods({ shipmentCategory: "package", itemsCount: null }))).toMatch(/colli/);
    expect(goodsStepError(goods({ shipmentCategory: "full_vehicle", description: " " }))).toMatch(/Descrivi/);
    expect(goodsStepError(goods({ shipmentCategory: "full_vehicle", palletsCount: null, itemsCount: null }))).toBeNull();
    expect(goodsStepError(goods({ shipmentCategory: "document", itemsCount: null }))).toBeNull();
  });

  it("the vehicle check uses the cleared goods: a full vehicle has no sizes, a gitterbox counts as a pallet place", () => {
    const state = (g: Partial<WizardState["goods"]>) => ({ ...EMPTY_WIZARD_STATE, goods: goods(g) });
    expect(loadNeeds(state({ shipmentCategory: "full_vehicle" }))).toEqual({ weightKg: null, largestItem: { lengthCm: null, widthCm: null, heightCm: null }, pallets: null, loadCategory: null });
    expect(loadNeeds(state({ shipmentCategory: "gitterbox" })).pallets).toBe(2);
    // no category (older state, Deposito chain): as entered
    expect(loadNeeds(state({ shipmentCategory: null })).loadCategory).toBe("bilocale");
  });

  it("a state saved before D176 is still valid (no category, not stackable)", () => {
    const old = JSON.parse(JSON.stringify(EMPTY_WIZARD_STATE));
    delete old.goods.shipmentCategory;
    delete old.goods.stackable;
    expect(parseStoredState(JSON.stringify(old))?.goods).toMatchObject({ shipmentCategory: null, stackable: false });
  });
});
