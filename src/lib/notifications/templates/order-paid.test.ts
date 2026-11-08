import { describe, expect, it } from "vitest";
import { renderOrderPaidEmail } from "./order-paid";

const base = {
  firstName: "Giulia",
  orderNumber: "TG-2026-000042",
  pickupCity: "Milano",
  deliveryCity: "Torino",
  pickupWindowStart: new Date("2026-12-01T09:00:00Z"), // 10:00 in Rome
  pickupWindowEnd: new Date("2026-12-01T11:00:00Z"),
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
    const m = renderOrderPaidEmail({ ...base, firstName: "<script>x</script>", pickupCity: "A & B" });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("A &amp; B");
  });

  it("generic greeting without a first name; business total marked VAT included", () => {
    const m = renderOrderPaidEmail({ ...base, firstName: null, customerType: "business" });
    expect(m.text.startsWith("Ciao,")).toBe(true);
    expect(m.text).toContain("195,20 € (IVA inclusa)");
  });
});
