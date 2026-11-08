import { describe, expect, it } from "vitest";
import {
  assessVehicles,
  belowMinimumText,
  blockText,
  itemDims,
  itemFits,
  NO_VEHICLE_FITS,
  recommendationText,
  type CategoryMinimums,
  type LoadNeeds,
  type VehicleCapacity,
} from "./vehicle-fit";

// Placeholder fleet from D81.
const V: Record<string, VehicleCapacity> = {
  car: { id: "car", nameIt: "Auto", sizeRank: 1, payloadKg: 400, lengthCm: 150, widthCm: 100, heightCm: 80, euroPallets: 0 },
  small: { id: "small", nameIt: "Furgone piccolo", sizeRank: 2, payloadKg: 750, lengthCm: 180, widthCm: 140, heightCm: 125, euroPallets: 2 },
  medium: { id: "medium", nameIt: "Furgone medio", sizeRank: 3, payloadKg: 1200, lengthCm: 300, widthCm: 170, heightCm: 180, euroPallets: 4 },
  large: { id: "large", nameIt: "Furgone grande", sizeRank: 4, payloadKg: 1000, lengthCm: 420, widthCm: 205, heightCm: 220, euroPallets: 8 },
  truck: { id: "truck", nameIt: "Camion", sizeRank: 5, payloadKg: 3000, lengthCm: 600, widthCm: 240, heightCm: 240, euroPallets: 15 },
};
// Input order deliberately not by size.
const FLEET = [V.medium, V.truck, V.car, V.large, V.small];
const MIN: CategoryMinimums = { monolocale: "medium", bilocale: "large", trilocale_plus: "large" };

const needs = (patch: Partial<LoadNeeds> = {}): LoadNeeds => ({ weightKg: null, largestItem: null, pallets: null, loadCategory: null, ...patch });
const item = (l: number | null, w: number | null = null, h: number | null = null) => ({ lengthCm: l, widthCm: w, heightCm: h });
const fit = (n: LoadNeeds, fleet = FLEET, min = MIN) => assessVehicles(fleet, n, min);
const blocked = (n: LoadNeeds, fleet = FLEET) => Object.fromEntries(fit(n, fleet).assessments.map((a) => [a.vehicleTypeId, a.blockedBy]));

describe("dimensions: rotation allowed, no diagonal (D82)", () => {
  it("compares sorted item dimensions with sorted cargo dimensions", () => {
    expect(itemFits([140, 100, 70], V.car)).toBe(true); // 150×100×80
    expect(itemFits(itemDims(item(70, 145, 95)), V.car)).toBe(true); // any order given
    expect(itemFits([151], V.car)).toBe(false);
    expect(itemFits([150, 100, 81], V.car)).toBe(false);
  });

  it("partly given dimensions: only those are checked", () => {
    expect(itemDims(item(220))).toEqual([220]);
    expect(itemDims(item(null, 90, 0))).toEqual([90]);
    expect(itemFits([300], V.medium)).toBe(true);
    expect(itemFits([301], V.medium)).toBe(false);
    expect(itemFits([175, 175], V.medium)).toBe(true); // 175 ≤ 300, 175 ≤ 180
    expect(itemFits([175, 175, 175], V.medium)).toBe(false); // third side: 175 > 170
  });

  it("vehicle without dimensions → cannot check", () => {
    expect(itemFits([100], { lengthCm: null, widthCm: 100, heightCm: 100 })).toBeNull();
    expect(itemFits([], { lengthCm: null, widthCm: null, heightCm: null })).toBe(true);
  });
});

describe("blocks (D84)", () => {
  it("weight: equal to payload fits, 1 kg more is blocked", () => {
    expect(blocked(needs({ weightKg: 750 })).small).toEqual([]);
    expect(blocked(needs({ weightKg: 751 })).small).toEqual(["weight"]);
  });

  it("weight 1100 kg: the 3,5 t box van (1000 kg) is blocked, the medium van (1200 kg) is not", () => {
    const b = blocked(needs({ weightKg: 1100 }));
    expect(b).toMatchObject({ car: ["weight"], small: ["weight"], medium: [], large: ["weight"], truck: [] });
    expect(fit(needs({ weightKg: 1100 })).recommended?.vehicleTypeId).toBe("medium");
  });

  it("pallets: over capacity blocked; a car takes none", () => {
    const b = blocked(needs({ pallets: 4 }));
    expect(b).toMatchObject({ car: ["pallets"], small: ["pallets"], medium: [], large: [] });
    expect(blockText("pallets", V.car)).toBe("Non trasporta pallet.");
    expect(blockText("pallets", V.small)).toBe("Massimo 2 pallet.");
  });

  it("several reasons at once", () => {
    expect(blocked(needs({ weightKg: 500, largestItem: item(200), pallets: 1 })).car).toEqual(["weight", "dimensions", "pallets"]);
  });

  it("Italian block messages", () => {
    expect(blockText("weight", V.small)).toBe("Portata insufficiente: max 750 kg.");
    expect(blockText("dimensions", V.small)).toBe("L'oggetto più grande non entra nel vano (180 × 140 × 125 cm).");
    expect(blockText("weight", V.truck)).toBe("Portata insufficiente: max 3.000 kg.");
  });
});

describe("recommendation (D82)", () => {
  it("no data at all → the smallest vehicle", () => {
    expect(fit(needs()).recommended).toEqual({ vehicleTypeId: "car", reason: { kind: "smallest" } });
    expect(recommendationText({ kind: "smallest" })).toBe("Il veicolo più piccolo disponibile.");
  });

  it("smallest vehicle that satisfies weight, item and pallets", () => {
    const r = fit(needs({ weightKg: 600, largestItem: item(220, 90, 80), pallets: 2 })).recommended;
    expect(r?.vehicleTypeId).toBe("medium"); // small: 220 > 180
    expect(recommendationText(r!.reason)).toBe("Il più piccolo adatto a 600 kg, un oggetto di 220 × 90 × 80 cm, 2 pallet.");
  });

  it("a long item laid down fits a shorter van if it fits after rotation", () => {
    // 170 × 130 × 60: fits the small van (180 × 140 × 125)
    expect(fit(needs({ largestItem: item(60, 170, 130) })).recommended?.vehicleTypeId).toBe("small");
  });

  it("nothing fits → no recommendation, everything blocked", () => {
    const f = fit(needs({ weightKg: 5000 }));
    expect(f.recommended).toBeNull();
    expect(f.assessments.every((a) => a.blockedBy.includes("weight"))).toBe(true);
    expect(NO_VEHICLE_FITS).toMatch(/contattaci/);
  });

  it("assessments keep the input order", () => {
    expect(fit(needs()).assessments.map((a) => a.vehicleTypeId)).toEqual(FLEET.map((v) => v.id));
  });
});

describe("category minimum (D83)", () => {
  it("bilocale → at least the large van; smaller ones are only a warning, not blocked", () => {
    const f = fit(needs({ loadCategory: "bilocale" }));
    expect(f.recommended).toEqual({ vehicleTypeId: "large", reason: { kind: "category", category: "bilocale" } });
    const small = f.assessments.find((a) => a.vehicleTypeId === "small")!;
    expect(small).toMatchObject({ blockedBy: [], belowCategoryMinimum: true });
    expect(f.assessments.find((a) => a.vehicleTypeId === "truck")?.belowCategoryMinimum).toBe(false);
    expect(recommendationText(f.recommended!.reason)).toBe("Minimo consigliato per un trasloco bilocale.");
    expect(belowMinimumText("bilocale")).toBe("Potrebbe non bastare per un trasloco bilocale.");
  });

  it("weight rules out the category minimum → next bigger vehicle, reason = load data", () => {
    // bilocale min = large (1000 kg), but 1100 kg blocks it → truck
    const f = fit(needs({ loadCategory: "bilocale", weightKg: 1100 }));
    expect(f.recommended?.vehicleTypeId).toBe("truck");
    expect(f.recommended?.reason).toEqual({ kind: "fit", weightKg: 1100, item: [], pallets: null });
  });

  it("load data already needs a vehicle above the minimum → reason = load data", () => {
    const f = fit(needs({ loadCategory: "monolocale", largestItem: item(350) }));
    expect(f.recommended?.vehicleTypeId).toBe("large");
    expect(f.recommended?.reason.kind).toBe("fit");
  });

  it("category without minimum (parcels) or no category → no warning", () => {
    expect(fit(needs({ loadCategory: "parcels" })).assessments.some((a) => a.belowCategoryMinimum)).toBe(false);
    expect(fit(needs()).assessments.some((a) => a.belowCategoryMinimum)).toBe(false);
  });

  it("minimum vehicle not offered (inactive / not priced) → no minimum", () => {
    const f = fit(needs({ loadCategory: "bilocale" }), [V.car, V.small, V.medium]);
    expect(f.recommended?.vehicleTypeId).toBe("car");
    expect(f.assessments.some((a) => a.belowCategoryMinimum)).toBe(false);
  });
});

describe("missing vehicle parameters (D85)", () => {
  it("a criterion without a vehicle parameter is not checked (not blocked) and is reported", () => {
    const unknown: VehicleCapacity = { id: "x", nameIt: "X", sizeRank: 1, payloadKg: null, lengthCm: null, widthCm: 100, heightCm: 100, euroPallets: null };
    const f = assessVehicles([unknown, V.truck], needs({ weightKg: 900, largestItem: item(250), pallets: 3 }), {});
    expect(f.assessments[0]).toEqual({ vehicleTypeId: "x", blockedBy: [], belowCategoryMinimum: false, unchecked: ["weight", "dimensions", "pallets"] });
    expect(f.recommended?.vehicleTypeId).toBe("x");
  });

  it("zero or empty customer values do not restrict", () => {
    expect(fit(needs({ weightKg: 0, pallets: 0, largestItem: item(0, null, null) })).recommended?.vehicleTypeId).toBe("car");
  });
});
