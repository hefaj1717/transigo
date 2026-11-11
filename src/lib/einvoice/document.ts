// Invoice / credit note content (pure, tested). Built from the order snapshot (order_charges, order_lines, payment)
// and the company data (settings.company_*). Amounts in cents. Content follows D1–D3 and D26 (pending the
// commercialista): one invoice per payment, a refund = a credit note to that invoice.
import type { CompanyInfo } from "../public/company";
import { EInvoiceError } from "./provider";

export type Seller = {
  name: string;
  vatNumber: string | null;
  registeredOffice: string | null;
  email: string | null;
  pec: string | null;
};

export type Buyer = {
  customerType: "private" | "business";
  /** private: first + last name; business: company name */
  name: string;
  fiscalCode: string | null;
  vatNumber: string | null;
  sdiCode: string | null;
  pec: string | null;
  address: string | null;
};

export type DocumentLine = {
  description: string;
  quantity: number;
  netCents: number;
  vatCents: number;
  grossCents: number;
};

type Common = {
  /** id of the invoices row (also the idempotency key) */
  id: string;
  orderNumber: string;
  seller: Seller;
  buyer: Buyer;
  vatRateBp: number;
  lines: DocumentLine[];
  netCents: number;
  vatCents: number;
  totalCents: number;
};

export type InvoiceDocument = Common & {
  kind: "invoice";
  payment: { method: "card_stripe"; paidAt: Date };
};

export type CreditNoteDocument = Common & {
  kind: "credit_note";
  original: { number: string; issuedAt: Date };
  refundedAt: Date | null;
};

// ---------------------------------------------------------------------------
// Inputs (rows read by the server)
// ---------------------------------------------------------------------------
export type ChargesRow = {
  customer_type: "private" | "business";
  vat_rate_bp: number;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  billing_details: Record<string, unknown>;
};
export type LineRow = { sort_order: number; label_it: string; quantity: number; net_cents: number; vat_cents: number; gross_cents: number };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function sellerFrom(company: CompanyInfo): Seller {
  return { name: company.name, vatNumber: company.vatNumber, registeredOffice: company.registeredOffice, email: company.email, pec: company.pec };
}

/** Buyer from the order_charges.billing_details snapshot (D36, D43, D44). */
export function buyerFrom(customerType: "private" | "business", b: Record<string, unknown>): Buyer {
  const street = str(b.street);
  const city = str(b.city);
  const cap = str(b.postal_code);
  const province = str(b.province)?.toUpperCase() ?? null;
  const address = street && city ? `${street}, ${[cap, city].filter(Boolean).join(" ")}${province ? ` (${province})` : ""}` : null;
  const person = [str(b.first_name), str(b.last_name)].filter(Boolean).join(" ");
  if (customerType === "business") {
    return {
      customerType,
      name: str(b.company_name) ?? person,
      fiscalCode: str(b.fiscal_code),
      vatNumber: str(b.vat_number),
      sdiCode: str(b.sdi_code),
      pec: str(b.pec),
      address,
    };
  }
  return { customerType, name: person, fiscalCode: str(b.fiscal_code), vatNumber: null, sdiCode: null, pec: null, address };
}

/**
 * Snapshots written before the names were part of billing_details (demo seeds before 2026-11-11) have no person:
 * the customer's profile name fills ONLY the missing first / last name (the wizard always stores them, D36).
 * Everything else stays as in the snapshot.
 */
export function withProfileName(
  billing: Record<string, unknown>,
  profile: { first_name: string | null; last_name: string | null } | null,
): Record<string, unknown> {
  if (str(billing.first_name) || str(billing.last_name) || !profile) return billing;
  return { ...billing, first_name: profile.first_name, last_name: profile.last_name };
}

export type InvoiceSnapshot = {
  invoiceId: string;
  orderNumber: string;
  charges: ChargesRow;
  lines: LineRow[];
  paidAt: Date;
  /** invoices row amounts (copied from order_charges by queue_invoice) */
  amounts: { netCents: number; vatCents: number; totalCents: number };
};

/**
 * The invoice. The lines must add up to the order totals and to the queued row — otherwise `amount_mismatch`
 * (never issue a document whose lines and totals disagree).
 */
export function buildInvoiceDocument(s: InvoiceSnapshot, company: CompanyInfo): InvoiceDocument {
  const lines = [...s.lines]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((l) => ({ description: l.label_it, quantity: l.quantity, netCents: l.net_cents, vatCents: l.vat_cents, grossCents: l.gross_cents }));
  const sum = (k: "netCents" | "vatCents" | "grossCents") => lines.reduce((t, l) => t + l[k], 0);
  const c = s.charges;
  if (
    lines.length === 0 ||
    sum("netCents") !== c.subtotal_cents || sum("vatCents") !== c.vat_cents || sum("grossCents") !== c.total_cents ||
    c.subtotal_cents !== s.amounts.netCents || c.vat_cents !== s.amounts.vatCents || c.total_cents !== s.amounts.totalCents
  ) {
    throw new EInvoiceError("amount_mismatch");
  }
  const buyer = buyerFrom(c.customer_type, c.billing_details);
  if (!buyer.name) throw new EInvoiceError("buyer_missing");
  return {
    kind: "invoice",
    id: s.invoiceId,
    orderNumber: s.orderNumber,
    seller: sellerFrom(company),
    buyer,
    vatRateBp: c.vat_rate_bp,
    lines,
    netCents: c.subtotal_cents,
    vatCents: c.vat_cents,
    totalCents: c.total_cents,
    payment: { method: "card_stripe", paidAt: s.paidAt },
  };
}

export type CreditNoteSnapshot = {
  noteId: string;
  orderNumber: string;
  charges: ChargesRow;
  /** the issued invoice */
  invoice: { number: string; issuedAt: Date };
  /** the note row amounts (computed by queue_credit_note) */
  amounts: { netCents: number; vatCents: number; totalCents: number };
  refundedAt: Date | null;
};

/** The credit note: one line "Storno parziale / totale della fattura n. …" with the amounts of the note row. */
export function buildCreditNoteDocument(s: CreditNoteSnapshot, company: CompanyInfo, invoiceTotalCents: number): CreditNoteDocument {
  const a = s.amounts;
  if (a.totalCents <= 0 || a.netCents + a.vatCents !== a.totalCents || a.totalCents > invoiceTotalCents) {
    throw new EInvoiceError("amount_mismatch");
  }
  const buyer = buyerFrom(s.charges.customer_type, s.charges.billing_details);
  if (!buyer.name) throw new EInvoiceError("buyer_missing");
  const full = a.totalCents === invoiceTotalCents;
  return {
    kind: "credit_note",
    id: s.noteId,
    orderNumber: s.orderNumber,
    seller: sellerFrom(company),
    buyer,
    vatRateBp: s.charges.vat_rate_bp,
    lines: [{
      description: `${full ? "Storno totale" : "Storno parziale"} della fattura n. ${s.invoice.number} (rimborso ordine ${s.orderNumber})`,
      quantity: 1,
      netCents: a.netCents,
      vatCents: a.vatCents,
      grossCents: a.totalCents,
    }],
    netCents: a.netCents,
    vatCents: a.vatCents,
    totalCents: a.totalCents,
    original: s.invoice,
    refundedAt: s.refundedAt,
  };
}

/**
 * Credit note amounts — the same formula as queue_credit_note() in the database (D150; preview and tests only, the
 * database computes the stored amounts). VAT cumulative, round half up, so the notes of an invoice add up exactly:
 *   vat = round_half_up(cum × invoiceVat / invoiceTotal) − earlier notes' VAT, net = refund − vat.
 * Returns null when the notes would exceed the invoice.
 */
export function creditNoteAmounts(
  invoice: { vatCents: number; totalCents: number },
  earlier: { totalCents: number; vatCents: number }[],
  refundCents: number,
): { netCents: number; vatCents: number; totalCents: number } | null {
  if (!Number.isInteger(refundCents) || refundCents <= 0 || invoice.totalCents <= 0) return null;
  const prevTotal = earlier.reduce((t, n) => t + n.totalCents, 0);
  const prevVat = earlier.reduce((t, n) => t + n.vatCents, 0);
  const cum = prevTotal + refundCents;
  if (cum > invoice.totalCents) return null;
  // round half up of a non-negative fraction, integers only: floor((2·a·b + c) / (2·c)); BigInt — no float.
  const two = BigInt(2);
  const cumVat = (two * BigInt(cum) * BigInt(invoice.vatCents) + BigInt(invoice.totalCents)) / (two * BigInt(invoice.totalCents));
  const vat = Number(cumVat) - prevVat;
  return { netCents: refundCents - vat, vatCents: vat, totalCents: refundCents };
}
