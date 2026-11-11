import { describe, expect, it } from "vitest";
import type { OrderSummary } from "../../orders/order-summary";
import { renderOrderPaidEmail } from "./order-paid";

const transport: OrderSummary = {
  service: "transport", pickupCity: "Milano", deliveryCity: "Torino",
  window: { start: new Date("2026-12-01T09:00:00Z"), end: new Date("2026-12-01T11:00:00Z") }, // 10:00 in Rome
};

const base = {
  firstName: "Giulia",
  orderNumber: "TG-2026-000042",
  summary: transport,
  totalCents: 19_520,
  customerType: "private" as const,
  orderUrl: "https://app.example/cliente/ordini/abc",
};

describe("order paid e-mail (Italian)", () => {
  it("subject and body carry the order number, route, Rome time and total", () => {
    const m = renderOrderPaidEmail(base);
    expect(m.subject).toBe("Pagamento confermato – ordine TG-2026-000042");
    expect(m.text).toContain("Ciao Giulia,");
    expect(m.text).toContain("Milano → Torino");
    expect(m.text).toContain("tra le 10:00 e le 12:00");
    expect(m.text).toContain("195,20 €");
    expect(m.text).toContain("https://app.example/cliente/ordini/abc");
    expect(m.html).toContain("<strong>TG-2026-000042</strong>");
  });

  it("escapes HTML in names and cities", () => {
    const m = renderOrderPaidEmail({ ...base, firstName: "<script>x</script>", summary: { ...transport, pickupCity: "A & B" } });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("A &amp; B");
  });

  it("generic greeting without a first name; business total marked VAT included", () => {
    const m = renderOrderPaidEmail({ ...base, firstName: null, customerType: "business" });
    expect(m.text.startsWith("Ciao,")).toBe(true);
    expect(m.text).toContain("195,20 € (IVA inclusa)");
  });

  it("Facchinaggio: city, window, team — no route, no carrier wording; next step for porters", () => {
    const m = renderOrderPaidEmail({ ...base, summary: { service: "porters", city: "Bologna", window: transport.window, persons: 3, hours: 4 } });
    expect(m.text).toContain("Servizio: Facchinaggio a Bologna");
    expect(m.text).toContain("Quando: martedì 1 dicembre 2026, tra le 10:00 e le 12:00");
    expect(m.text).toContain("Squadra: 3 facchini, 4 ore");
    expect(m.text).toContain("squadra di facchini");
    expect(m.text).not.toContain("Percorso");
    expect(m.text).not.toContain("trasportatore");
  });

  it("Deposito: unit and period, warehouse instructions follow", () => {
    const m = renderOrderPaidEmail({ ...base, summary: { service: "storage", startDate: "2026-12-01", endDate: "2026-12-31", unitLabel: "Box M" } });
    expect(m.text).toContain("Deposito: Box M");
    expect(m.text).toContain("Periodo: dal 01/12/2026 al 31/12/2026");
    expect(m.text).toContain("indicazioni per portare la merce in magazzino");
    expect(m.text).not.toContain("Ritiro");
  });
});
