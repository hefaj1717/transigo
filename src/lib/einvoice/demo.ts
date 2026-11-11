// DEMO adapter (D144): a PDF with the watermark, SDI status simulated at once ("delivered"), no FatturaPA XML.
// Numbers from the separate DEMO series reserved for the row (D145, D150), so a retry returns the same number.
// Refuses to run on production.
import { assertDemoAllowed } from "./config";
import type { CreditNoteDocument, InvoiceDocument } from "./document";
import { renderDemoPdf } from "./demo-pdf";
import { EInvoiceError, type EInvoiceProvider, type IssueResult } from "./provider";

export type DemoDeps = {
  /** reserve_demo_invoice_number(invoice id) — the same number on every call for the same row */
  reserveNumber: (invoiceId: string) => Promise<string>;
  now?: () => Date;
  env?: Record<string, string | undefined>;
};

export const DEMO_NUMBER = /^DEMO(-NC)?-\d{4}-\d{4,}$/;

export function createDemoProvider(deps: DemoDeps): EInvoiceProvider {
  assertDemoAllowed(deps.env ?? process.env);
  const now = deps.now ?? (() => new Date());

  async function issue(doc: InvoiceDocument | CreditNoteDocument, key: string): Promise<IssueResult> {
    if (key !== doc.id) throw new EInvoiceError("idempotency_key_mismatch");
    const number = await deps.reserveNumber(key);
    if (!DEMO_NUMBER.test(number) || (doc.kind === "credit_note") !== number.startsWith("DEMO-NC-")) {
      throw new EInvoiceError("demo_number_invalid");
    }
    const issuedAt = now();
    const pdf = await renderDemoPdf(doc, number, issuedAt);
    return { providerDocumentId: `demo:${key}`, number, issuedAt, sdiStatus: "delivered", pdf };
  }

  return {
    name: "demo",
    isDemo: true,
    issueInvoice: (doc, key) => issue(doc, key),
    issueCreditNote: (doc, key) => issue(doc, key),
    getStatus: async () => "delivered",
    getPdf: async () => null, // kept in the bucket at issue time
  };
}
