import { describe, expect, it } from "vitest";
import type { OrderSummary } from "../../orders/order-summary";
import { renderOrderAssignedEmail, renderOrderDeliveredEmail } from "./order-customer-updates";

const window = { start: new Date("2026-11-12T09:00:00Z"), end: new Date("2026-11-12T11:00:00Z") };
const transport: OrderSummary = { service: "transport", pickupCity: "Milano", deliveryCity: "Torino", window };
const porters: OrderSummary = { service: "porters", city: "Bologna", window, persons: 2, hours: 3 };
const base = { firstName: "Anna", orderNumber: "TG-2026-000123", summary: transport, orderUrl: "https://t.example/cliente/ordini/1" };

describe("order_assigned e-mail", () => {
  const m = renderOrderAssignedEmail({
    ...base, carrierFirstName: "Mario", carrierCompany: "Trasporti <Rossi> Srl", vehicleType: "Furgone medio", plate: "AB123CD",
  });

  it("subject, carrier, vehicle, Rome time window and link", () => {
    expect(m.subject).toBe("Trasportatore assegnato – ordine TG-2026-000123");
    expect(m.text).toContain("Ciao Anna,");
    expect(m.text).toContain("Mario (Trasporti <Rossi> Srl)");
    expect(m.text).toContain("Furgone medio, targa AB123CD");
    expect(m.text).toContain("tra le 10:00 e le 12:00"); // Europe/Rome (UTC+1 in November)
    expect(m.text).toContain(base.orderUrl);
  });

  it("escapes HTML", () => {
    expect(m.html).toContain("Trasporti &lt;Rossi&gt; Srl");
    expect(m.html).not.toContain("<Rossi>");
  });

  it("works without first names and vehicle", () => {
    const n = renderOrderAssignedEmail({ ...base, firstName: null, carrierFirstName: null, carrierCompany: "Ditta", vehicleType: null, plate: null });
    expect(n.text.startsWith("Ciao,")).toBe(true);
    expect(n.text).toContain("Trasportatore: Ditta");
    expect(n.text).not.toContain("Veicolo");
  });
});

describe("order_delivered e-mail", () => {
  it("subject, delivery time and link", () => {
    const m = renderOrderDeliveredEmail({ ...base, deliveredAt: new Date("2026-11-12T15:30:00Z") });
    expect(m.subject).toBe("Ordine consegnato – TG-2026-000123");
    expect(m.text).toContain("16:30");
    expect(m.text).toContain(base.orderUrl);
  });

  it("Facchinaggio: team, no vehicle even if one is passed", () => {
    const p = renderOrderDeliveredEmail({ ...base, summary: porters, deliveredAt: new Date("2026-11-12T15:30:00Z") });
    expect(p.subject).toBe("Lavoro concluso – TG-2026-000123");
    expect(p.text).toContain("Servizio: Facchinaggio a Bologna");
    expect(p.text).toContain("Concluso: ");
    expect(p.text).not.toContain("consegnato");
  });
});

describe("order_assigned e-mail — Facchinaggio (D164, D165)", () => {
  const m = renderOrderAssignedEmail({ ...base, summary: porters, carrierFirstName: "Mario", carrierCompany: "Facchini Srl", vehicleType: "Furgone", plate: "AB123CD" });
  it("Facchini assegnati, city, window, team; never a vehicle or plate", () => {
    expect(m.subject).toBe("Facchini assegnati – ordine TG-2026-000123");
    expect(m.text).toContain("squadra di facchini");
    expect(m.text).toContain("Facchini: Mario (Facchini Srl)");
    expect(m.text).toContain("Quando: giovedì 12 novembre 2026, tra le 10:00 e le 12:00");
    expect(m.text).toContain("Squadra: 2 facchini, 3 ore");
    expect(m.text).not.toContain("Veicolo");
    expect(m.text).not.toContain("AB123CD");
    expect(m.text).not.toContain("Trasportatore");
  });
});
