// Contract every EInvoiceProvider adapter must pass (run from the adapter's test; vitest only).
// A new adapter (Fatture in Cloud) runs the same suite against its sandbox / a fake transport.
import { expect, it } from "vitest";
import type { CreditNoteDocument, InvoiceDocument } from "./document";
import { EInvoiceError, type EInvoiceProvider } from "./provider";

const SDI = ["not_sent", "sent", "delivered", "rejected"];

export function providerContract(make: () => EInvoiceProvider, docs: { invoice: InvoiceDocument; note: CreditNoteDocument }) {
  it("contract: issues an invoice with a number, date, SDI status and a document id", async () => {
    const p = make();
    const r = await p.issueInvoice(docs.invoice, docs.invoice.id);
    expect(r.number.length).toBeGreaterThan(0);
    expect(r.issuedAt).toBeInstanceOf(Date);
    expect(SDI).toContain(r.sdiStatus);
    expect(r.providerDocumentId.length).toBeGreaterThan(0);
    expect(SDI).toContain(await p.getStatus(r.providerDocumentId));
    const pdf = r.pdf ?? (await p.getPdf(r.providerDocumentId));
    expect(pdf && new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
  });

  it("contract: the same idempotency key never issues a second document", async () => {
    const p = make();
    const a = await p.issueInvoice(docs.invoice, docs.invoice.id);
    const b = await p.issueInvoice(docs.invoice, docs.invoice.id);
    expect(b.number).toBe(a.number);
    expect(b.providerDocumentId).toBe(a.providerDocumentId);
  });

  it("contract: a credit note gets its own number", async () => {
    const p = make();
    const inv = await p.issueInvoice(docs.invoice, docs.invoice.id);
    const nc = await p.issueCreditNote(docs.note, docs.note.id);
    expect(nc.number).not.toBe(inv.number);
  });

  it("contract: errors are EInvoiceError with a code (key that is not the document id)", async () => {
    await expect(make().issueInvoice(docs.invoice, "another-key")).rejects.toBeInstanceOf(EInvoiceError);
  });
}
