import { describe, expect, it } from "vitest";
import type { PublicCatalog } from "./server";
import { serviceAvailable, serviceTexts } from "./services";

const catalog: PublicCatalog = {
  bookingAvailable: true,
  vehicles: [{ id: "v1", name: "Furgone", payloadKg: 1000, lengthCm: 300, widthCm: 170, heightCm: 180, volumeM3: 9, euroPallets: 4 }],
  portersAvailable: true,
  porterPackages: [{ code: "parcels", label: "Pochi colli", persons: 1, includedHours: 1 }],
  packingAvailable: true,
  storageAvailable: true,
  storageMaxDays: 30,
  storageBillingUnit: "pallet_day",
  warehouseCity: "Milano",
  maxDistanceKm: 300,
  minLeadHours: 3,
};

describe("serviceAvailable", () => {
  it("follows the active price list", () => {
    expect(serviceAvailable("trasporto", catalog)).toBe(true);
    expect(serviceAvailable("trasporto", { ...catalog, vehicles: [] })).toBe(false);
    expect(serviceAvailable("facchinaggio", { ...catalog, portersAvailable: false })).toBe(false);
    expect(serviceAvailable("imballaggio", { ...catalog, packingAvailable: false })).toBe(false);
    expect(serviceAvailable("deposito-merci", { ...catalog, storageAvailable: false })).toBe(false);
  });

  it("nothing is bookable without an active price list", () => {
    for (const code of ["trasporto", "facchinaggio", "imballaggio", "deposito-merci"] as const) {
      expect(serviceAvailable(code, { ...catalog, bookingAvailable: false })).toBe(false);
    }
  });
});

describe("serviceTexts — storage (D117: short term only)", () => {
  it("shows the short-term limit and the billing unit from the price list", () => {
    const t = serviceTexts("deposito-merci", catalog);
    expect(t.includes).toContain("Deposito a breve termine, fino a 30 giorni");
    expect(t.pricing[0]).toBe("Tariffa per pallet al giorno");
    expect(serviceTexts("deposito-merci", { ...catalog, storageBillingUnit: "day" }).pricing[0]).toBe("Tariffa giornaliera");
  });

  it("never mentions long-term storage", () => {
    const all = [...serviceTexts("deposito-merci", catalog).includes, ...serviceTexts("deposito-merci", catalog).pricing].join(" ").toLowerCase();
    expect(all).not.toMatch(/lungo/);
  });

  it("other services use the static texts", () => {
    expect(serviceTexts("trasporto", catalog).includes.length).toBeGreaterThan(0);
  });
});
