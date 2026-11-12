// Shipment category labels (D176) — shared by the wizard summary, the customer, admin and carrier screens.
import type { ShipmentCategory } from "../booking/state";

export const SHIPMENT_LABEL: Record<ShipmentCategory, string> = {
  pallet: "Pallet",
  package: "Pacchi e colli",
  document: "Documenti",
  gitterbox: "Gitterbox",
  full_vehicle: "Veicolo intero",
};

/** "Pallet · sovrapponibile" / "Veicolo intero" / null for orders without a category (older orders, Deposito box). */
export function shipmentText(category: ShipmentCategory | null | undefined, stackable: boolean | null | undefined): string | null {
  if (!category) return null;
  return stackable ? `${SHIPMENT_LABEL[category]} · sovrapponibile` : SHIPMENT_LABEL[category];
}

/** For gitterbox the order's pallets_count is the number of gitterboxes (D176). */
export function palletsText(count: number, category: ShipmentCategory | null | undefined): string {
  if (category === "gitterbox") return count === 1 ? "1 gitterbox" : `${count} gitterbox`;
  return count === 1 ? "1 pallet" : `${count} pallet`;
}
