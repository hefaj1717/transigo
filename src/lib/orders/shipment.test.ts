import { describe, expect, it } from "vitest";
import { palletsText, shipmentText } from "./shipment";

describe("shipment labels (D176)", () => {
  it("category with the stackable flag; nothing for orders without a category", () => {
    expect(shipmentText("pallet", true)).toBe("Pallet · sovrapponibile");
    expect(shipmentText("full_vehicle", null)).toBe("Veicolo intero");
    expect(shipmentText(null, true)).toBeNull();
    expect(shipmentText(undefined, undefined)).toBeNull();
  });
  it("pallet places are gitterboxes for a gitterbox shipment", () => {
    expect(palletsText(1, "gitterbox")).toBe("1 gitterbox");
    expect(palletsText(3, "pallet")).toBe("3 pallet");
    expect(palletsText(2, null)).toBe("2 pallet");
  });
});
