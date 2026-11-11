import { describe, expect, it } from "vitest";
import { toCompanyInfo } from "../public/company";
import { buildCreditNoteDocument, buildInvoiceDocument, buyerFrom, creditNoteAmounts, type InvoiceSnapshot } from "./document";
import { EInvoiceError } from "./provider";

const company = toCompanyInfo({
  company_name: "Transigo S.r.l.", company_vat_number: "12345678901", company_street: "Via Roma 1", company_city: "Milano",
  company_postal_code: "20121", company_province: "mi", company_email: "info@example.com", company_phone: null, company_pec: null,
});

const privateBilling = { customer_type: "private", first_name: "Mario", last_name: "Rossi", email: "m@example.com", fiscal_code: "RSSMRA80A01F205X", street: "Via Po 2", city: "Torino", postal_code: "10124", province: "to", country: "IT" };
const businessBilling = { customer_type: "business", first_name: "Anna", last_name: "Verdi", company_name: "Verdi S.p.A.", vat_number: "01234567890", sdi_code: "ABC1234", pec: null, street: "Via Dante 3", city: "Roma", postal_code: "00184", province: "RM" };

const snapshot = (over: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot => ({
  invoiceId: "inv-1",
  orderNumber: "TG-000042",
  charges: { customer_type: "private", vat_rate_bp: 2200, subtotal_cents: 16_000, vat_cents: 3_520, total_cents: 19_520, billing_details: privateBilling },
  lines: [
    { sort_order: 1, label_it: "Facchinaggio", quantity: 1, net_cents: 6_000, vat_cents: 1_320, gross_cents: 7_320 },
    { sort_order: 0, label_it: "Trasporto", quantity: 1, net_cents: 10_000, vat_cents: 2_200, gross_cents: 12_200 },
  ],
  paidAt: new Date("2026-11-10T10:00:00Z"),
  amounts: { netCents: 16_000, vatCents: 3_520, totalCents: 19_520 },
  ...over,
});

describe("buildInvoiceDocument", () => {
  it("seller from settings, buyer from the snapshot, lines in order, totals", () => {
    const d = buildInvoiceDocument(snapshot(), company);
    expect(d.kind).toBe("invoice");
    expect(d.seller).toMatchObject({ name: "Transigo S.r.l.", vatNumber: "12345678901", registeredOffice: "Via Roma 1, 20121 Milano (MI)" });
    expect(d.buyer).toEqual({ customerType: "private", name: "Mario Rossi", fiscalCode: "RSSMRA80A01F205X", vatNumber: null, sdiCode: null, pec: null, address: "Via Po 2, 10124 Torino (TO)" });
    expect(d.lines.map((l) => l.description)).toEqual(["Trasporto", "Facchinaggio"]);
    expect([d.netCents, d.vatCents, d.totalCents]).toEqual([16_000, 3_520, 19_520]);
    expect(d.payment).toEqual({ method: "card_stripe", paidAt: new Date("2026-11-10T10:00:00Z") });
  });

  it("business buyer: company, P.IVA, SDI code", () => {
    expect(buyerFrom("business", businessBilling)).toEqual({
      customerType: "business", name: "Verdi S.p.A.", fiscalCode: null, vatNumber: "01234567890", sdiCode: "ABC1234", pec: null, address: "Via Dante 3, 00184 Roma (RM)",
    });
  });

  it("lines that do not add up, or a row with other amounts → amount_mismatch", () => {
    const bad = snapshot({ lines: [{ sort_order: 0, label_it: "Trasporto", quantity: 1, net_cents: 10_000, vat_cents: 2_200, gross_cents: 12_200 }] });
    expect(() => buildInvoiceDocument(bad, company)).toThrow(new EInvoiceError("amount_mismatch"));
    expect(() => buildInvoiceDocument(snapshot({ amounts: { netCents: 16_000, vatCents: 3_520, totalCents: 19_521 } }), company)).toThrow(EInvoiceError);
    expect(() => buildInvoiceDocument(snapshot({ lines: [] }), company)).toThrow(EInvoiceError);
  });

  it("no buyer name → buyer_missing", () => {
    const s = snapshot();
    s.charges = { ...s.charges, billing_details: { fiscal_code: "X" } };
    expect(() => buildInvoiceDocument(s, company)).toThrow(new EInvoiceError("buyer_missing"));
  });
});

describe("creditNoteAmounts (= queue_credit_note in the database, same examples as tests/rls/invoices.test.ts)", () => {
  const inv = { vatCents: 3_520, totalCents: 19_520 };

  it("cumulative VAT: three partial refunds add up exactly to the invoice", () => {
    const a = creditNoteAmounts(inv, [], 3_333)!;
    expect(a).toEqual({ netCents: 2_732, vatCents: 601, totalCents: 3_333 });
    const b = creditNoteAmounts(inv, [a], 3_333)!;
    expect(b).toEqual({ netCents: 2_732, vatCents: 601, totalCents: 3_333 });
    const c = creditNoteAmounts(inv, [a, b], 19_520 - 6_666)!;
    expect(c).toEqual({ netCents: 10_536, vatCents: 2_318, totalCents: 12_854 });
    expect(a.vatCents + b.vatCents + c.vatCents).toBe(3_520);
  });

  it("round half up at exactly .5", () => {
    // 5 × 100 / 200 = 2.5 → 3; then cumulative 10 → 5 (+2)
    const x = creditNoteAmounts({ vatCents: 100, totalCents: 200 }, [], 5)!;
    expect(x.vatCents).toBe(3);
    expect(creditNoteAmounts({ vatCents: 100, totalCents: 200 }, [x], 5)!.vatCents).toBe(2);
    // 1 × 1 / 2 = 0.5 → 1
    expect(creditNoteAmounts({ vatCents: 1, totalCents: 2 }, [], 1)).toEqual({ netCents: 0, vatCents: 1, totalCents: 1 });
  });

  it("full refund = invoice VAT; over the invoice or not a positive integer → null", () => {
    expect(creditNoteAmounts(inv, [], 19_520)).toEqual({ netCents: 16_000, vatCents: 3_520, totalCents: 19_520 });
    expect(creditNoteAmounts(inv, [], 19_521)).toBeNull();
    expect(creditNoteAmounts(inv, [{ totalCents: 19_000, vatCents: 3_426 }], 521)).toBeNull();
    for (const v of [0, -1, 1.5]) expect(creditNoteAmounts(inv, [], v)).toBeNull();
  });
});

describe("buildCreditNoteDocument", () => {
  const base = {
    noteId: "nc-1", orderNumber: "TG-000042", charges: snapshot().charges,
    invoice: { number: "DEMO-2026-0001", issuedAt: new Date("2026-11-10T10:00:00Z") }, refundedAt: null,
  };

  it("one storno line referencing the invoice; partial vs total", () => {
    const partial = buildCreditNoteDocument({ ...base, amounts: { netCents: 2_732, vatCents: 601, totalCents: 3_333 } }, company, 19_520);
    expect(partial.lines).toEqual([{ description: "Storno parziale della fattura n. DEMO-2026-0001 (rimborso ordine TG-000042)", quantity: 1, netCents: 2_732, vatCents: 601, grossCents: 3_333 }]);
    expect(partial.original.number).toBe("DEMO-2026-0001");
    const total = buildCreditNoteDocument({ ...base, amounts: { netCents: 16_000, vatCents: 3_520, totalCents: 19_520 } }, company, 19_520);
    expect(total.lines[0].description).toMatch(/^Storno totale/);
  });

  it("inconsistent amounts → amount_mismatch", () => {
    expect(() => buildCreditNoteDocument({ ...base, amounts: { netCents: 1, vatCents: 1, totalCents: 3 } }, company, 19_520)).toThrow(EInvoiceError);
    expect(() => buildCreditNoteDocument({ ...base, amounts: { netCents: 16_001, vatCents: 3_520, totalCents: 19_521 } }, company, 19_520)).toThrow(EInvoiceError);
  });
});
