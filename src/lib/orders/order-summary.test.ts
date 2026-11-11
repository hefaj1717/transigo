import { describe, expect, it } from "vitest";
import { checkoutProductName, formatWindow, startLabel, summaryLine, summaryRows, summaryWindow, toOrderSummary } from "./order-summary";

const leg = (i: number, from: string, to: string, start: string) => ({
  leg_index: i, pickup_city: from, delivery_city: to, pickup_window_start: start, pickup_window_end: new Date(Date.parse(start) + 2 * 3600_000).toISOString(),
});

describe("toOrderSummary", () => {
  it("transport: first pickup → last delivery, window of leg 0 (legs in any order)", () => {
    const s = toOrderSummary({
      service_type: "transport",
      order_legs: [leg(1, "Magazzino", "Torino", "2026-12-05T08:00:00Z"), leg(0, "Milano", "Magazzino", "2026-12-01T09:00:00Z")],
      order_porter_jobs: null, warehouse_bookings: null,
    });
    expect(s).toEqual({ service: "transport", pickupCity: "Milano", deliveryCity: "Torino", window: { start: new Date("2026-12-01T09:00:00Z"), end: new Date("2026-12-01T11:00:00Z") } });
  });

  it("missing or unknown service_type is transport (orders before D151)", () => {
    expect(toOrderSummary({ order_legs: [leg(0, "A", "B", "2026-12-01T09:00:00Z")] }).service).toBe("transport");
  });

  it("porters: from the porter job (object or array embed), billed hours", () => {
    const job = { city: "Bologna", window_start: "2026-12-01T09:00:00Z", window_end: "2026-12-01T11:00:00Z", persons: 3, billed_hours: 4 };
    const expected = { service: "porters", city: "Bologna", window: { start: new Date(job.window_start), end: new Date(job.window_end) }, persons: 3, hours: 4 };
    expect(toOrderSummary({ service_type: "porters", order_legs: [], order_porter_jobs: job })).toEqual(expected);
    expect(toOrderSummary({ service_type: "porters", order_legs: [], order_porter_jobs: [job] })).toEqual(expected);
  });

  it("storage: unit and period", () => {
    expect(toOrderSummary({ service_type: "storage", warehouse_bookings: { start_date: "2026-12-01", end_date: "2026-12-31", unit: "pallet", box_code: null, pallets: 3 } }))
      .toEqual({ service: "storage", startDate: "2026-12-01", endDate: "2026-12-31", unitLabel: "3 pallet" });
  });

  it("throws on a broken snapshot instead of producing an empty text", () => {
    expect(() => toOrderSummary({ service_type: "transport", order_legs: [] })).toThrow(/without legs/);
    expect(() => toOrderSummary({ service_type: "porters", order_porter_jobs: null })).toThrow(/porter job/);
    expect(() => toOrderSummary({ service_type: "storage", warehouse_bookings: [] })).toThrow(/booking/);
  });
});

describe("formatting (Europe/Rome, Italian)", () => {
  const window = { start: new Date("2026-07-01T07:00:00Z"), end: new Date("2026-07-01T09:00:00Z") }; // summer: UTC+2
  const transport = { service: "transport" as const, pickupCity: "Milano", deliveryCity: "Torino", window };
  const porters = { service: "porters" as const, city: "Bologna", window, persons: 2, hours: 1 };
  const storage = { service: "storage" as const, startDate: "2026-12-01", endDate: "2027-01-15", unitLabel: "Box S" };

  it("window in Rome time", () => {
    expect(formatWindow(window)).toBe("mercoledì 1 luglio 2026, tra le 09:00 e le 11:00");
  });

  it("one line and rows per service", () => {
    expect(summaryLine(transport)).toBe("Milano → Torino");
    expect(summaryLine(porters)).toBe("Facchinaggio a Bologna");
    expect(summaryLine(storage)).toBe("Deposito Box S dal 01/12/2026 al 15/01/2027");
    expect(summaryRows(transport).map(([k]) => k)).toEqual(["Percorso", "Ritiro"]);
    expect(summaryRows(porters)).toContainEqual(["Squadra", "2 facchini, 1 ora"]);
    expect(summaryRows(storage)).toEqual([["Deposito", "Box S"], ["Periodo", "dal 01/12/2026 al 15/01/2027"]]);
  });

  it("start label and window; product name for Checkout", () => {
    expect([transport, porters, storage].map(startLabel)).toEqual(["Ritiro", "Inizio lavoro", "Inizio deposito"]);
    expect(summaryWindow(storage)).toBeNull();
    expect(summaryWindow(porters)).toBe(window);
    expect(checkoutProductName("TG-1", transport)).toBe("Ordine TG-1 – Trasporto e servizi");
    expect(checkoutProductName("TG-1", porters)).toBe("Ordine TG-1 – Facchinaggio");
    expect(checkoutProductName("TG-1", storage)).toBe("Ordine TG-1 – Deposito");
  });
});
