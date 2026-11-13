import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, type PDFObject } from "pdf-lib";
import { toCompanyInfo } from "../public/company";
import { assertDemoAllowed, isProduction, providerNameFrom } from "./config";
import { createDemoProvider } from "./demo";
import { DEMO_WATERMARK, renderDemoPdf } from "./demo-pdf";
import { buildCreditNoteDocument, buildInvoiceDocument, type InvoiceDocument } from "./document";
import { EInvoiceError, errorCode } from "./provider";
import { providerContract } from "./provider-contract";

const company = toCompanyInfo({
  company_name: "Transigo S.r.l.", company_vat_number: "12345678901", company_street: "Via Roma 1", company_city: "Milano",
  company_postal_code: "20121", company_province: "MI", company_email: null, company_phone: null, company_pec: null,
});
const charges = {
  customer_type: "private" as const, vat_rate_bp: 2200, subtotal_cents: 16_000, vat_cents: 3_520, total_cents: 19_520,
  billing_details: { first_name: "Niccolò", last_name: "Città", fiscal_code: "RSSMRA80A01F205X", street: "Via Po 2", city: "Torino", postal_code: "10124", province: "TO" },
};
const invoice = buildInvoiceDocument({
  invoiceId: "11111111-1111-1111-1111-111111111111", orderNumber: "TG-000042", charges,
  lines: [
    { sort_order: 0, label_it: "Trasporto Milano → Torino ✓", quantity: 1, net_cents: 10_000, vat_cents: 2_200, gross_cents: 12_200 },
    { sort_order: 1, label_it: "Facchinaggio (2 persone)", quantity: 1, net_cents: 6_000, vat_cents: 1_320, gross_cents: 7_320 },
  ],
  paidAt: new Date("2026-11-10T10:00:00Z"), amounts: { netCents: 16_000, vatCents: 3_520, totalCents: 19_520 },
}, company);
const note = buildCreditNoteDocument({
  noteId: "22222222-2222-2222-2222-222222222222", orderNumber: "TG-000042", charges,
  invoice: { number: "DEMO-2026-0001", issuedAt: new Date("2026-11-10T10:00:00Z") },
  amounts: { netCents: 2_732, vatCents: 601, totalCents: 3_333 }, refundedAt: new Date("2026-11-11T10:00:00Z"),
}, company, 19_520);

/** In-memory reserve_demo_invoice_number: one number per row, separate series per kind. */
function fakeReserve() {
  const byId = new Map<string, string>();
  const counters = { DEMO: 0, "DEMO-NC": 0 };
  return async (id: string) => {
    const known = byId.get(id);
    if (known) return known;
    const series = id === note.id ? "DEMO-NC" : "DEMO";
    const n = `${series}-2026-${String(++counters[series]).padStart(4, "0")}`;
    byId.set(id, n);
    return n;
  };
}
const make = () => createDemoProvider({ reserveNumber: fakeReserve(), env: {} });

/** All page content streams of a PDF, decompressed, as latin1 text. */
async function contents(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((p) => {
    const ref = p.node.get(PDFName.of("Contents"));
    const top = pdf.context.lookup(ref);
    const streams: (PDFObject | undefined)[] = top instanceof PDFArray ? top.asArray().map((r) => pdf.context.lookup(r)) : [top];
    return streams.map((s) => {
      const raw = s as PDFRawStream;
      const data = raw.getContents();
      return (raw.dict.get(PDFName.of("Filter")) ? inflateSync(Buffer.from(data)) : Buffer.from(data)).toString("latin1");
    }).join("\n");
  });
}
const hex = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();

describe("DEMO adapter", () => {
  providerContract(make, { invoice, note });

  it("numbers from the DEMO series; SDI simulated as delivered; PDF returned", async () => {
    const p = make();
    expect(p).toMatchObject({ name: "demo", isDemo: true });
    const r = await p.issueInvoice(invoice, invoice.id);
    expect(r).toMatchObject({ number: "DEMO-2026-0001", sdiStatus: "delivered", providerDocumentId: `demo:${invoice.id}` });
    expect((await p.issueCreditNote(note, note.id)).number).toBe("DEMO-NC-2026-0001");
    expect(await p.getPdf(r.providerDocumentId)).toBeNull();
  });

  it("refuses a number outside the DEMO series (we never take a real-looking number)", async () => {
    const p = createDemoProvider({ reserveNumber: async () => "2026/0001", env: {} });
    await expect(p.issueInvoice(invoice, invoice.id)).rejects.toThrow(new EInvoiceError("demo_number_invalid"));
    const wrongSeries = createDemoProvider({ reserveNumber: async () => "DEMO-2026-0001", env: {} });
    await expect(wrongSeries.issueCreditNote(note, note.id)).rejects.toThrow(new EInvoiceError("demo_number_invalid"));
  });

  it("refuses to run on production", () => {
    for (const env of [{ VERCEL_ENV: "production" }, { SITE_INDEXING: "on" }]) {
      expect(() => createDemoProvider({ reserveNumber: fakeReserve(), env })).toThrow(expect.objectContaining({ code: "demo_on_production" }));
    }
    expect(() => createDemoProvider({ reserveNumber: fakeReserve(), env: { VERCEL_ENV: "preview" } })).not.toThrow();
    // the demo address = Vercel production on the staging database (D180)
    expect(() => createDemoProvider({ reserveNumber: fakeReserve(), env: { VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://bacabuzzevwwdxrswbnc.supabase.co" } })).not.toThrow();
  });
});

describe("DEMO PDF", () => {
  it("watermark on every page, also with many lines; unsupported characters replaced", async () => {
    const many: InvoiceDocument = {
      ...invoice,
      lines: Array.from({ length: 80 }, (_, i) => ({ description: `Voce ${i} con una descrizione molto lunga che va tagliata alla larghezza della colonna`, quantity: 1, netCents: 200, vatCents: 44, grossCents: 244 })),
      netCents: 16_000, vatCents: 3_520, totalCents: 19_520,
    };
    const bytes = await renderDemoPdf(many, "DEMO-2026-0001", new Date("2026-11-10T10:00:00Z"));
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(pdf.getTitle()).toBe("Fattura DEMO-2026-0001 (DEMO)");
    const pages = await contents(bytes);
    // pdf-lib writes WinAnsi text as hex strings; "—" is 0x97 in WinAnsi.
    const mark = hex("DEMO ") + "97" + hex(" documento senza valore fiscale");
    for (const c of pages) expect(c).toContain(mark);
  });

  it("arrows become '-', characters outside WinAnsi become '?'", async () => {
    const doc: InvoiceDocument = { ...invoice, lines: [{ ...invoice.lines[0], description: "Łódź → Città ✓" }, invoice.lines[1]] };
    const [page] = await contents(await renderDemoPdf(doc, "DEMO-2026-0001", new Date()));
    expect(page).toContain(hex("?ód? - Citt\u00e0 "));
  });

  it("renders a credit note referencing the invoice", async () => {
    const bytes = await renderDemoPdf(note, "DEMO-NC-2026-0001", new Date("2026-11-11T10:00:00Z"));
    const [page] = await contents(bytes);
    expect(page).toContain(hex("Rif. fattura n. DEMO-2026-0001 del 10/11/2026"));
    expect(DEMO_WATERMARK).toBe("DEMO — documento senza valore fiscale");
  });
});

describe("config", () => {
  it("EINVOICE_PROVIDER: default demo, known names, otherwise an error", () => {
    expect(providerNameFrom({})).toBe("demo");
    expect(providerNameFrom({ EINVOICE_PROVIDER: " fatture_in_cloud " })).toBe("fatture_in_cloud");
    expect(() => providerNameFrom({ EINVOICE_PROVIDER: "acme" })).toThrow(expect.objectContaining({ code: "provider_config" }));
  });

  it("production = indexable site, or Vercel production on a database other than staging", () => {
    expect(isProduction({ VERCEL_ENV: "production" })).toBe(true);
    expect(isProduction({ VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://otherproject.supabase.co" })).toBe(true);
    expect(isProduction({ VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://bacabuzzevwwdxrswbnc.supabase.co/" })).toBe(false);
    expect(isProduction({ VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://bacabuzzevwwdxrswbnc.supabase.co", SITE_INDEXING: "on" })).toBe(true);
    expect(isProduction({ SITE_INDEXING: "on" })).toBe(true);
    expect(isProduction({ VERCEL_ENV: "preview", SITE_INDEXING: "off" })).toBe(false);
    expect(() => assertDemoAllowed({})).not.toThrow();
  });

  it("errorCode: only safe codes are stored", () => {
    expect(errorCode(new EInvoiceError("amount_mismatch"))).toBe("amount_mismatch");
    expect(errorCode(new EInvoiceError("Mario Rossi non trovato"))).toBe("provider_error");
    expect(errorCode(new Error("x"))).toBe("provider_error");
  });
});
