import { describe, expect, it } from "vitest";
import { renderInvoiceIssuedEmail } from "./invoice-issued";

const base = { kind: "invoice" as const, firstName: "Mario", number: "DEMO-2026-0001", orderNumber: "TG-000042", totalCents: 19_520, isDemo: true, invoicesUrl: "https://x.test/cliente/fatture" };

describe("invoice_issued e-mail", () => {
  it("invoice: number, order, amount, link, DEMO notice; no attachment data", () => {
    const m = renderInvoiceIssuedEmail(base);
    expect(m.subject).toBe("Fattura DEMO-2026-0001 – ordine TG-000042");
    expect(m.text).toContain("è disponibile la fattura n. DEMO-2026-0001 per l'ordine TG-000042 (195,20 €)");
    expect(m.text).toContain("Documento DEMO senza valore fiscale");
    expect(m.html).toContain('href="https://x.test/cliente/fatture"');
  });

  it("credit note; real documents without the DEMO notice; HTML escaped", () => {
    const m = renderInvoiceIssuedEmail({ ...base, kind: "credit_note", isDemo: false, number: "NC<1>", firstName: null });
    expect(m.subject).toBe("Nota di credito NC<1> – ordine TG-000042");
    expect(m.text).not.toContain("DEMO senza valore");
    expect(m.html).toContain("NC&lt;1&gt;");
    expect(m.text.startsWith("Ciao,")).toBe(true);
  });
});
