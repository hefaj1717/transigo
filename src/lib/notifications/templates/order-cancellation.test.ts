import { describe, expect, it } from "vitest";
import type { OrderSummary } from "../../orders/order-summary";
import { renderCancellationRequestedEmail, renderCarrierJobCancelledEmail, renderOrderCancelledEmail } from "./order-cancellation";

const window = { start: new Date("2026-11-20T09:00:00Z"), end: new Date("2026-11-20T11:00:00Z") };
const transport: OrderSummary = { service: "transport", pickupCity: "Milano", deliveryCity: "Torino", window };
const porters: OrderSummary = { service: "porters", city: "Bologna", window, persons: 2, hours: 3 };
const storage: OrderSummary = { service: "storage", startDate: "2026-12-01", endDate: "2026-12-31", unitLabel: "Box M" };

describe("order_cancelled (customer)", () => {
  const data = { firstName: "Anna", orderNumber: "TG-1", feeCents: 500, refundCents: 9_500, orderUrl: "https://t.example/o/1" };
  it("summary line per service", () => {
    expect(renderOrderCancelledEmail({ ...data, summary: transport }).text).toContain("TG-1 (Milano → Torino) è stato annullato");
    expect(renderOrderCancelledEmail({ ...data, summary: porters }).text).toContain("TG-1 (Facchinaggio a Bologna) è stato annullato");
    expect(renderOrderCancelledEmail({ ...data, summary: storage }).text).toContain("TG-1 (Deposito Box M dal 01/12/2026 al 31/12/2026) è stato annullato");
  });
});

describe("cancellation_requested (admin) — no customer data", () => {
  const data = { orderNumber: "TG-1", companyName: "Ditta", adminOrderUrl: "https://t.example/admin/1" };
  it("planned start label per service", () => {
    expect(renderCancellationRequestedEmail({ ...data, summary: transport }).text).toContain("Ritiro previsto: venerdì 20 novembre 2026, 10:00–12:00");
    expect(renderCancellationRequestedEmail({ ...data, summary: porters }).text).toContain("Inizio lavoro previsto: venerdì 20 novembre 2026, 10:00–12:00");
    const s = renderCancellationRequestedEmail({ ...data, summary: storage }).text;
    expect(s).not.toContain("previsto:");
    expect(s).toContain("Ordine: TG-1");
  });
});

describe("carrier_job_cancelled (carrier)", () => {
  const data = { firstName: "Mario", orderNumber: "TG-1", jobUrl: "https://t.example/p/1" };
  it("transport: route and planned pickup", () => {
    const t = renderCarrierJobCancelledEmail({ ...data, summary: transport }).text;
    expect(t).toContain("Percorso: Milano → Torino");
    expect(t).toContain("Ritiro previsto: venerdì 20 novembre 2026, 10:00–12:00");
    expect(t).not.toContain("Ritiro: ");
  });
  it("Facchinaggio: city, team and planned start — no route", () => {
    const t = renderCarrierJobCancelledEmail({ ...data, summary: porters }).text;
    expect(t).toContain("Servizio: Facchinaggio a Bologna");
    expect(t).toContain("Squadra: 2 facchini, 3 ore");
    expect(t).toContain("Inizio lavoro previsto: venerdì 20 novembre 2026, 10:00–12:00");
    expect(t).not.toContain("Percorso");
    expect(t).not.toContain("Quando:");
  });
});
