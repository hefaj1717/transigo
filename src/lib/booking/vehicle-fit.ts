// Vehicle recommendation for the booking wizard (D82–D85). Pure: no database, no UI.
//
// A vehicle is BLOCKED when the load cannot physically go in: weight > payload, the largest item does not fit
// the cargo space (rotation allowed, no diagonal placement), or more EUR pallets than it takes (D84).
// A vehicle below the minimum for the load category (D83) is allowed, with a warning.
// The recommendation is the smallest vehicle (size_rank) that is neither blocked nor below the minimum.
// Missing customer data does not restrict; a missing vehicle parameter is not checked (D85).
// Known limitation (D82): door opening sizes and diagonal placement are not considered.
import type { PorterPackageCode } from "../pricing/types";

export type VehicleCapacity = {
  id: string;
  nameIt: string;
  sizeRank: number;
  payloadKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  euroPallets: number | null;
};

export type ItemSize = { lengthCm: number | null; widthCm: number | null; heightCm: number | null };

export type LoadNeeds = {
  weightKg: number | null;
  largestItem: ItemSize | null;
  pallets: number | null;
  loadCategory: PorterPackageCode | null; // D83; null = not a move
};

/** D83: load category → minimum vehicle type id (no entry = no minimum). */
export type CategoryMinimums = Partial<Record<PorterPackageCode, string>>;

export type BlockReason = "weight" | "dimensions" | "pallets";

export type VehicleAssessment = {
  vehicleTypeId: string;
  blockedBy: BlockReason[];
  belowCategoryMinimum: boolean;
  /** Criteria the customer gave but this vehicle has no parameter for (not checked, D85). */
  unchecked: BlockReason[];
};

export type RecommendationReason =
  | { kind: "category"; category: PorterPackageCode }
  | { kind: "fit"; weightKg: number | null; item: number[]; pallets: number | null }
  | { kind: "smallest" };

export type VehicleFit = {
  assessments: VehicleAssessment[]; // same order as the input vehicles
  recommended: { vehicleTypeId: string; reason: RecommendationReason } | null;
};

const desc = (xs: number[]) => [...xs].sort((a, b) => b - a);

/** Provided item dimensions, largest first (0 or missing values are ignored). */
export function itemDims(item: ItemSize | null): number[] {
  if (!item) return [];
  return desc([item.lengthCm, item.widthCm, item.heightCm].filter((x): x is number => typeof x === "number" && x > 0));
}

/**
 * Rotation allowed: the k given item dimensions (largest first) must each fit the k largest cargo dimensions.
 * null = cannot check (vehicle dimensions missing).
 */
export function itemFits(item: number[], v: Pick<VehicleCapacity, "lengthCm" | "widthCm" | "heightCm">): boolean | null {
  if (!item.length) return true;
  if (v.lengthCm === null || v.widthCm === null || v.heightCm === null) return null;
  const cargo = desc([v.lengthCm, v.widthCm, v.heightCm]);
  return item.every((d, i) => d <= cargo[i]);
}

function minimumRank(vehicles: VehicleCapacity[], needs: LoadNeeds, minimums: CategoryMinimums): number | null {
  if (!needs.loadCategory) return null;
  const id = minimums[needs.loadCategory];
  const v = id ? vehicles.find((x) => x.id === id) : undefined;
  return v ? v.sizeRank : null; // minimum vehicle not offered (inactive / not priced) → no minimum
}

export function assessVehicle(v: VehicleCapacity, needs: LoadNeeds, minRank: number | null): VehicleAssessment {
  const blockedBy: BlockReason[] = [];
  const unchecked: BlockReason[] = [];

  if (needs.weightKg !== null && needs.weightKg > 0) {
    if (v.payloadKg === null) unchecked.push("weight");
    else if (needs.weightKg > v.payloadKg) blockedBy.push("weight");
  }
  const fits = itemFits(itemDims(needs.largestItem), v);
  if (fits === null) unchecked.push("dimensions");
  else if (!fits) blockedBy.push("dimensions");
  if (needs.pallets !== null && needs.pallets > 0) {
    if (v.euroPallets === null) unchecked.push("pallets");
    else if (needs.pallets > v.euroPallets) blockedBy.push("pallets");
  }

  return { vehicleTypeId: v.id, blockedBy, belowCategoryMinimum: minRank !== null && v.sizeRank < minRank, unchecked };
}

export function assessVehicles(vehicles: VehicleCapacity[], needs: LoadNeeds, minimums: CategoryMinimums): VehicleFit {
  const minRank = minimumRank(vehicles, needs, minimums);
  const assessments = vehicles.map((v) => assessVehicle(v, needs, minRank));
  const byRank = vehicles.map((v, i) => ({ v, a: assessments[i] })).sort((x, y) => x.v.sizeRank - y.v.sizeRank);
  const pick = byRank.find(({ a }) => !a.blockedBy.length && !a.belowCategoryMinimum);
  if (!pick) return { assessments, recommended: null };

  // Why: the category minimum, if that is what ruled out the smaller vehicles; otherwise the load data.
  const smallerFitting = byRank.some(({ v, a }) => v.sizeRank < pick.v.sizeRank && !a.blockedBy.length);
  const item = itemDims(needs.largestItem);
  const hasLoadData = (needs.weightKg ?? 0) > 0 || item.length > 0 || (needs.pallets ?? 0) > 0;
  let reason: RecommendationReason;
  if (needs.loadCategory && minRank !== null && pick.v.sizeRank === minRank && smallerFitting) reason = { kind: "category", category: needs.loadCategory };
  else if (hasLoadData) reason = { kind: "fit", weightKg: needs.weightKg && needs.weightKg > 0 ? needs.weightKg : null, item, pallets: needs.pallets && needs.pallets > 0 ? needs.pallets : null };
  else if (needs.loadCategory && minRank !== null && pick.v.sizeRank === minRank) reason = { kind: "category", category: needs.loadCategory };
  else reason = { kind: "smallest" };
  return { assessments, recommended: { vehicleTypeId: pick.v.id, reason } };
}

// ---------------------------------------------------------------------------
// Italian texts (UI language)
// ---------------------------------------------------------------------------

/** Thousands with a dot, as in Italian ("3.000"); Intl's it-IT does not group 4-digit numbers. */
const num = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

export const CATEGORY_PHRASE: Record<PorterPackageCode, string> = {
  parcels: "pochi colli",
  monolocale: "un trasloco monolocale",
  bilocale: "un trasloco bilocale",
  trilocale_plus: "un trasloco trilocale o più grande",
};

export const NO_VEHICLE_FITS = "Nessun veicolo adatto a questo carico: contattaci per un preventivo su misura.";

export function recommendationText(reason: RecommendationReason): string {
  switch (reason.kind) {
    case "category":
      return `Minimo consigliato per ${CATEGORY_PHRASE[reason.category]}.`;
    case "fit": {
      const parts = [
        reason.weightKg ? `${num(reason.weightKg)} kg` : null,
        reason.item.length ? `un oggetto di ${reason.item.map(num).join(" × ")} cm` : null,
        reason.pallets ? `${reason.pallets} pallet` : null,
      ].filter(Boolean);
      return `Il più piccolo adatto a ${parts.join(", ")}.`;
    }
    case "smallest":
      return "Il veicolo più piccolo disponibile.";
  }
}

export function blockText(reason: BlockReason, v: VehicleCapacity): string {
  switch (reason) {
    case "weight":
      return `Portata insufficiente: max ${num(v.payloadKg ?? 0)} kg.`;
    case "dimensions":
      return `L'oggetto più grande non entra nel vano (${num(v.lengthCm ?? 0)} × ${num(v.widthCm ?? 0)} × ${num(v.heightCm ?? 0)} cm).`;
    case "pallets":
      return v.euroPallets === 0 ? "Non trasporta pallet." : `Massimo ${v.euroPallets} pallet.`;
  }
}

export function belowMinimumText(category: PorterPackageCode): string {
  return `Potrebbe non bastare per ${CATEGORY_PHRASE[category]}.`;
}
