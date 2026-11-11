import { describe, expect, it } from "vitest";
import { canDownload, errorLabel, groupDocuments, parseAdminInvoiceTab, pdfFileName, type DocRow } from "./view";

const doc = (o: Partial<DocRow>): DocRow => ({
  id: "x", kind: "invoice", order_id: "o", invoice_id: null, refund_id: null, status: "issued", sdi_status: "delivered", number: "DEMO-2026-0001",
  issued_at: "2026-11-10T10:00:00Z", is_demo: true, net_cents: 100, vat_cents: 22, total_cents: 122, pdf_path: "o/x.pdf", created_at: "2026-11-10T10:00:00Z", ...o,
});

describe("groupDocuments", () => {
  it("invoices newest first, notes under their invoice oldest first, orphans dropped", () => {
    const rows = [
      doc({ id: "a", created_at: "2026-11-01T00:00:00Z" }),
      doc({ id: "b", created_at: "2026-11-05T00:00:00Z" }),
      doc({ id: "n2", kind: "credit_note", invoice_id: "a", created_at: "2026-11-04T00:00:00Z" }),
      doc({ id: "n1", kind: "credit_note", invoice_id: "a", created_at: "2026-11-03T00:00:00Z" }),
      doc({ id: "orphan", kind: "credit_note", invoice_id: "zzz" }),
    ];
    expect(groupDocuments(rows).map((g) => [g.invoice.id, g.notes.map((n) => n.id)])).toEqual([["b", []], ["a", ["n1", "n2"]]]);
  });
});

describe("helpers", () => {
  it("download only when issued and stored", () => {
    expect(canDownload(doc({}))).toBe(true);
    expect(canDownload(doc({ status: "pending" }))).toBe(false);
    expect(canDownload(doc({ status: "failed" }))).toBe(false);
    expect(canDownload(doc({ pdf_path: null }))).toBe(false);
  });

  it("file name", () => {
    expect(pdfFileName({ kind: "invoice", number: "DEMO-2026-0001" })).toBe("Fattura_DEMO-2026-0001.pdf");
    expect(pdfFileName({ kind: "credit_note", number: "2026/12 A" })).toBe("Nota_di_credito_2026_12_A.pdf");
  });

  it("admin tab and error labels", () => {
    expect(parseAdminInvoiceTab("emesse")).toBe("emesse");
    for (const v of [undefined, "", "x", ["emesse"]]) expect(parseAdminInvoiceTab(v)).toBe("da-emettere");
    expect(errorLabel("pdf_store_failed")).toBe("PDF non salvato");
    expect(errorLabel("weird_code")).toBe("weird_code");
    expect(errorLabel(null)).toBeNull();
  });
});
