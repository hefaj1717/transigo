import { describe, expect, it } from "vitest";
import { makeConfig, V } from "@/lib/pricing/__fixtures__/config";
import { calculatePortersPrice } from "@/lib/pricing/porters-service";
import { calculateStoragePrice } from "@/lib/pricing/storage-service";
import { portersEstimate, publicAvailability, storageEstimate, toPublicRates, withVat } from "./rates";
import { parsePortersRequest, parseStorageRequest, portersContactHref, portersRequestHref, requestMessage, storageRequestHref } from "./requests";

const config = makeConfig();
const rates = toPublicRates(config, { vehicleIds: [V.car, V.vanSmall], warehouseActive: true });

describe("toPublicRates (D162)", () => {
  it("never carries carrier shares, overtime terms or the price list id", () => {
    const json = JSON.stringify(rates).toLowerCase();
    expect(json).not.toMatch(/carrier|share|overtime|pricelist|pl-1/);
  });

  it("lists only bookable vehicles, with their customer rates", () => {
    expect(rates.transport.vehicles.map((v) => v.vehicleTypeId)).toEqual([V.car, V.vanSmall]);
    expect(rates.transport.vehicles[0]).toMatchObject({ perKmCents: 90, minCents: 3500 });
    expect(rates.transport.urgent).toEqual({ kind: "percent", percentBp: 3000 });
  });

  it("porters only with the porters-only service and porter_hour", () => {
    expect(rates.porters).toMatchObject({ perHourCents: 3000, minPersons: 2, maxPersons: 4, minHours: 2, floorNoElevatorCents: 1000 });
    expect(toPublicRates(makeConfig({ portersService: null }), { vehicleIds: [], warehouseActive: true }).porters).toBeNull();
    const noHour = makeConfig({ rules: config.rules.filter((r) => r.code !== "porter_hour") });
    expect(toPublicRates(noHour, { vehicleIds: [], warehouseActive: true }).porters).toBeNull();
  });

  it("storage needs an active warehouse; disabled boxes are left out", () => {
    expect(toPublicRates(config, { vehicleIds: [], warehouseActive: false }).storage).toBeNull();
    const boxes = config.storageBoxes.map((b) => (b.code === "M" ? { ...b, isEnabled: false } : b));
    expect(toPublicRates(makeConfig({ storageBoxes: boxes }), { vehicleIds: [], warehouseActive: true }).storage!.boxes.map((b) => b.code)).toEqual(["S", "L"]);
  });

  it("availability", () => {
    expect(publicAvailability(rates)).toEqual({ trasporto: true, facchinaggio: true, deposito: true });
    expect(publicAvailability(null)).toEqual({ trasporto: false, facchinaggio: false, deposito: false });
    const noStorage = toPublicRates(makeConfig({ storageBoxes: [], rules: config.rules.filter((r) => r.code !== "storage_pallet_day") }), { vehicleIds: [], warehouseActive: true });
    expect(publicAvailability(noStorage).deposito).toBe(false);
  });

  it("withVat rounds half up", () => {
    expect(withVat(3000, 2200)).toBe(3660);
    expect(withVat(5, 2200)).toBe(6); // 1,1 → 1
  });
});

describe("portersEstimate — same arithmetic as the real quote, without date surcharges", () => {
  it("plan example: 2 porters, 3 h, 4th floor without elevator = 220,00 € net, 268,40 € gross", () => {
    expect(portersEstimate(rates, { persons: 2, hours: 3, floor: 4, hasElevator: false })).toMatchObject({ netCents: 22000, vatCents: 4840, grossCents: 26840 });
  });

  it("matches calculatePortersPrice on a weekday far ahead (no surcharge)", () => {
    for (const input of [
      { persons: 2, hours: 1, floor: 0, hasElevator: false },
      { persons: 3, hours: 5, floor: 2, hasElevator: true },
      { persons: 4, hours: 12, floor: 20, hasElevator: false },
    ]) {
      const real = calculatePortersPrice(
        { customerType: "private", now: new Date("2030-01-08T08:00:00Z"), startAt: new Date("2030-01-15T08:00:00Z"), province: "MI", ...input },
        makeConfig({ serviceAreaProvinces: ["MI"] }),
      );
      expect(real.ok).toBe(true);
      if (!real.ok) return;
      expect(portersEstimate(rates, input)?.grossCents).toBe(real.quote.totalCents);
    }
  });

  it("billed at least the minimum hours", () => {
    expect(portersEstimate(rates, { persons: 2, hours: 1, floor: 0, hasElevator: true })?.netCents).toBe(2 * 2 * 3000);
  });

  it("invalid input or no service → null", () => {
    expect(portersEstimate(rates, { persons: 1, hours: 2, floor: 0, hasElevator: true })).toBeNull();
    expect(portersEstimate(rates, { persons: 5, hours: 2, floor: 0, hasElevator: true })).toBeNull();
    expect(portersEstimate({ ...rates, porters: null }, { persons: 2, hours: 2, floor: 0, hasElevator: true })).toBeNull();
  });
});

describe("storageEstimate", () => {
  it("box: matches calculateStoragePrice", () => {
    for (const days of [1, 2, 30, 45, 100]) {
      const real = calculateStoragePrice({ customerType: "private", unit: "box", boxCode: "M", days }, config);
      expect(real.ok).toBe(true);
      if (!real.ok) return;
      expect(storageEstimate(rates, { unit: "box", boxCode: "M", days })?.grossCents).toBe(real.quote.totalCents);
    }
  });

  it("pallets: plan example 5 pallets × 20 days = 300,00 € net", () => {
    expect(storageEstimate(rates, { unit: "pallet", pallets: 5, days: 20 }, "business")?.netCents).toBe(30000);
    const real = calculateStoragePrice({ customerType: "business", unit: "pallet", pallets: 5, days: 50 }, config);
    expect(real.ok && storageEstimate(rates, { unit: "pallet", pallets: 5, days: 50 }, "business")?.netCents).toBe(real.ok ? real.quote.subtotalCents : -1);
  });

  it("no transshipment, unknown box or out of range → null", () => {
    expect(storageEstimate(rates, { unit: "pallet", pallets: 5, days: 0 })).toBeNull();
    expect(storageEstimate(rates, { unit: "box", boxCode: "XL", days: 5 })).toBeNull();
    expect(storageEstimate(rates, { unit: "pallet", pallets: 101, days: 5 })).toBeNull();
    expect(storageEstimate({ ...rates, storage: null }, { unit: "box", boxCode: "M", days: 5 })).toBeNull();
  });
});

describe("calculator → wizard (Facchinaggio, step 6) or contact request (Deposito until step 7, D162)", () => {
  const params = (href: string) => new URL(href, "https://x.it").searchParams;

  it("porters: the calculator opens the wizard with the values; the contact request keeps them too", () => {
    const input = { persons: 3, hours: 4, floor: 2, hasElevator: false };
    expect(portersRequestHref(input)).toBe("/prenota/facchini?servizio=facchinaggio&persone=3&ore=4&piano=2&ascensore=0");
    const href = portersContactHref(input);
    expect(href.startsWith("/contatti?")).toBe(true);
    expect(parsePortersRequest(params(href), rates)).toEqual(input);
    expect(requestMessage(params(href), rates)).toContain("3 facchini per circa 4 ore, 2° piano senza ascensore");
  });

  it("round trip storage (box and pallets)", () => {
    const box = storageRequestHref({ unit: "box", boxCode: "L", days: 60 });
    expect(parseStorageRequest(params(box), rates)).toEqual({ unit: "box", boxCode: "L", days: 60 });
    expect(requestMessage(params(box), rates)).toContain("Box L (10 m³) per 60 giorni");
    const pal = storageRequestHref({ unit: "pallet", pallets: 5, days: 1 });
    expect(requestMessage(params(pal), rates)).toContain("5 pallet per 1 giorno");
  });

  it("rejects anything outside the known values", () => {
    for (const q of [
      "servizio=facchinaggio&persone=9&ore=2&piano=0&ascensore=0",
      "servizio=facchinaggio&persone=2&ore=2&piano=0&ascensore=si",
      "servizio=facchinaggio&persone=2.5&ore=2&piano=0&ascensore=0",
      "servizio=deposito&giorni=10&box=<script>",
      "servizio=deposito&giorni=0&pallet=2",
      "servizio=altro",
      "",
    ]) {
      expect(requestMessage(new URLSearchParams(q), rates)).toBeNull();
    }
    expect(requestMessage(params(portersContactHref({ persons: 2, hours: 2, floor: 0, hasElevator: true })), null)).toBeNull();
  });
});
