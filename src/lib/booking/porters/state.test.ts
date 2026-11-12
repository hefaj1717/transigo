import { describe, expect, it } from "vitest";
import { toPublicPortersJob, portersErrorMessage, portersErrorStep } from "./messages";
import { EMPTY_PORTERS_STATE, parseStoredPortersState, portersPriceKey, portersStateSchema, type PortersState } from "./state";

const s: PortersState = {
  ...EMPTY_PORTERS_STATE,
  place: { placeId: "place-abcdefghij", label: "Via Roma 1", floor: 2, hasElevator: false },
  date: "2026-12-01", window: "10-12", persons: 3, hours: 4, description: "Divano",
};

describe("porters wizard state", () => {
  it("price key: place, floor, elevator, date, window, persons, hours — not the description or the view", () => {
    const key = portersPriceKey(s);
    expect(portersPriceKey({ ...s, description: "Altro", customerTypeView: "business", place: { ...s.place!, label: "Altra etichetta" } })).toBe(key);
    for (const changed of [
      { ...s, persons: 4 }, { ...s, hours: 5 }, { ...s, window: "12-14" as const }, { ...s, date: "2026-12-02" },
      { ...s, place: { ...s.place!, floor: 3 } }, { ...s, place: { ...s.place!, hasElevator: true } },
    ]) expect(portersPriceKey(changed)).not.toBe(key);
  });

  it("schema bounds: 1–4 persons (D177), 1–12 hours, floor ≤ 20; bad stored state is dropped", () => {
    expect(portersStateSchema.safeParse(s).success).toBe(true);
    for (const bad of [{ ...s, persons: 0 }, { ...s, persons: 5 }, { ...s, hours: 0 }, { ...s, hours: 13 }, { ...s, place: { ...s.place!, floor: 21 } }, { ...s, date: "2026-02-30" }]) {
      expect(portersStateSchema.safeParse(bad).success).toBe(false);
    }
    expect(parseStoredPortersState(JSON.stringify(s))).toEqual(s);
    expect(parseStoredPortersState("{bad")).toBeNull();
    expect(parseStoredPortersState(JSON.stringify({ ...s, version: 2 }))).toBeNull();
  });
});

describe("porters messages", () => {
  const ctx = { minLeadHours: 24, minPersons: 2, minHours: 2 };
  it("Italian messages and steps", () => {
    expect(portersErrorMessage({ code: "pickup_province", legIndex: 0, province: "PA" }, ctx)).toMatch(/non offriamo il facchinaggio/);
    expect(portersErrorStep({ code: "pickup_province", legIndex: 0, province: "PA" })).toBe("indirizzo");
    expect(portersErrorMessage({ code: "too_soon", legIndex: 0 }, ctx)).toBe("Prenota almeno 24 ore prima dell'inizio del lavoro.");
    expect(portersErrorStep({ code: "too_soon", legIndex: 0 })).toBe("data");
    expect(portersErrorMessage({ code: "invalid_input", message: "x" }, ctx)).toMatch(/almeno 2 facchini e 2 ore/);
  });

  it("public job terms: no carrier share; overtime gross for display", () => {
    const pub = toPublicPortersJob({ persons: 2, includedHours: 3, overtimeRatePerPersonCents: 3_500, overtimeGraceMinutes: 15, carrierShare: { kind: "percent", percentBp: 8000 } }, 2200);
    expect(pub).toEqual({ persons: 2, includedHours: 3, overtimeRateNetCents: 3_500, overtimeRateGrossCents: 4_270, overtimeGraceMinutes: 15 });
    expect(JSON.stringify(pub)).not.toContain("8000");
  });
});

describe("calculator prefill (D162)", () => {
  it("takes only integers in range; ignores anything else", async () => {
    const { parsePortersPrefill } = await import("./state");
    expect(parsePortersPrefill({ persone: "3", ore: "4", piano: "2", ascensore: "1" }, 2)).toEqual({ persons: 3, hours: 4, floor: 2, hasElevator: true });
    expect(parsePortersPrefill({ persone: "5", ore: "0", piano: "21", ascensore: "si" }, 2)).toEqual({ persons: undefined, hours: undefined, floor: undefined, hasElevator: undefined });
    expect(parsePortersPrefill({ persone: "2" }, 3)).toEqual({ persons: undefined, hours: undefined, floor: undefined, hasElevator: undefined });
    expect(parsePortersPrefill({ persone: ["3", "4"], ore: "3.5", piano: "-1" }, 2)).toEqual({ persons: undefined, hours: undefined, floor: undefined, hasElevator: undefined });
  });
});
