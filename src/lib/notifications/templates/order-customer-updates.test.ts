import { describe, expect, it } from "vitest";
import { renderOrderAssignedEmail, renderOrderDeliveredEmail } from "./order-customer-updates";

const base = { firstName: "Anna", orderNumber: "TG-2026-000123", pickupCity: "Milano", deliveryCity: "Torino", orderUrl: "https://t.example/cliente/ordini/1" };

describe("order_assigned e-mail", () => {
  const m = renderOrderAssignedEmail({
    ...base, carrierFirstName: "Mario", carrierCompany: "Trasporti <Rossi> Srl", vehicleType: "Furgone medio", plate: "AB123CD",
    pickupWindowStart: new Date("2026-11-12T09:00:00Z"), pickupWindowEnd: new Date("2026-11-12T11:00:00Z"),
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
    const n = renderOrderAssignedEmail({ ...base, firstName: null, carrierFirstName: null, carrierCompany: "Ditta", vehicleType: null, plate: null, pickupWindowStart: new Date(), pickupWindowEnd: new Date() });
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
});
