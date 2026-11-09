import { describe, expect, it } from "vitest";
import { heroToWizardState } from "./hero";
import { EMPTY_WIZARD_STATE, parseStoredState } from "./state";

const A = { placeId: "ChIJ_pickup_place_1", label: "Via Roma 1, Milano" };
const B = { placeId: "ChIJ_delivery_place_2", label: "Corso Italia 5, Torino" };
const TODAY = "2026-11-09";

describe("heroToWizardState", () => {
  it("builds a fresh wizard state with route and date", () => {
    const r = heroToWizardState({ pickup: A, delivery: B, date: "2026-11-12" }, TODAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.pickup).toEqual({ ...A, floor: 0, hasElevator: false });
    expect(r.state.delivery).toEqual({ ...B, floor: 0, hasElevator: false });
    expect(r.state.pickupDate).toBe("2026-11-12");
    expect(r.state.pickupWindow).toBeNull();
  });

  it("is restorable by the wizard (same schema, same storage format)", () => {
    const r = heroToWizardState({ pickup: A, delivery: B, date: "" }, TODAY);
    if (!r.ok) throw new Error("expected ok");
    expect(parseStoredState(JSON.stringify(r.state))).toEqual(r.state);
    expect(r.state.pickupDate).toBeNull(); // date is optional
  });

  it("drops the previous booking but keeps the Privato/Azienda view", () => {
    const previous = { ...EMPTY_WIZARD_STATE, customerTypeView: "business" as const, packingItems: 7, goods: { ...EMPTY_WIZARD_STATE.goods, description: "Divano" } };
    const r = heroToWizardState({ pickup: A, delivery: B, date: TODAY }, TODAY, previous);
    if (!r.ok) throw new Error("expected ok");
    expect(r.state.customerTypeView).toBe("business");
    expect(r.state.packingItems).toBe(0);
    expect(r.state.goods.description).toBe("");
  });

  it("requires both addresses chosen from the list", () => {
    expect(heroToWizardState({ pickup: null, delivery: B, date: "" }, TODAY)).toMatchObject({ ok: false, field: "pickup" });
    expect(heroToWizardState({ pickup: A, delivery: null, date: "" }, TODAY)).toMatchObject({ ok: false, field: "delivery" });
  });

  it("refuses past or malformed dates", () => {
    expect(heroToWizardState({ pickup: A, delivery: B, date: "2026-11-08" }, TODAY)).toMatchObject({ ok: false, field: "date" });
    expect(heroToWizardState({ pickup: A, delivery: B, date: "2026-02-30" }, TODAY)).toMatchObject({ ok: false, field: "date" });
  });

  it("refuses a place id the wizard would not accept", () => {
    expect(heroToWizardState({ pickup: { placeId: "bad id!", label: "x" }, delivery: B, date: "" }, TODAY)).toMatchObject({ ok: false, field: "pickup" });
  });
});
