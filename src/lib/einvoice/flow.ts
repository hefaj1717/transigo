// Issuing customer documents (D144–D147). Orchestration only: the database, the provider and the e-mail come in as
// dependencies (real ones in ./server.ts; tests: src/lib/einvoice/flow.test.ts and tests/rls/einvoice-flow.test.ts).
//
// Order, always: `invoices` row 'pending' (queue_*) → provider (idempotency key = row id) → PDF to the private bucket
// → record_invoice_result. A provider / document error is recorded as 'failed' with a CODE and never undoes the
// payment or the refund; the cron /api/cron/einvoice or the admin ("Riprova") tries again.
import { buildCreditNoteDocument, buildInvoiceDocument, type CreditNoteSnapshot, type InvoiceSnapshot } from "./document";
import type { CompanyInfo } from "../public/company";
import { EInvoiceError, errorCode, type EInvoiceProvider, type IssueResult } from "./provider";
import { invoiceDueFor, type OrderFacts, type PaymentFacts } from "./trigger";

export type InvoiceRow = {
  id: string;
  kind: "invoice" | "credit_note";
  order_id: string;
  payment_id: string;
  refund_id: string | null;
  invoice_id: string | null;
  provider: string;
  status: "pending" | "issued" | "failed";
  number: string | null;
  net_cents: number;
  vat_cents: number;
  total_cents: number;
};

export type QueueOutcome = { invoiceId: string; newlyQueued: boolean } | { waiting: true };

export type EInvoiceDeps = {
  provider: EInvoiceProvider;
  company: () => Promise<CompanyInfo>;
  paymentFacts: (paymentId: string) => Promise<{ payment: PaymentFacts; order: OrderFacts } | null>;
  /** succeeded payments of an order (the webhook knows the order, not the payment) */
  orderPaymentIds: (orderId: string) => Promise<string[]>;
  queueInvoice: (paymentId: string, provider: string) => Promise<{ invoiceId: string; newlyQueued: boolean }>;
  /** { waiting: true } when the database answers invoice_not_issued (D146) */
  queueCreditNote: (refundId: string) => Promise<QueueOutcome>;
  /** succeeded refunds of a payment that have no credit note yet */
  refundsWithoutNote: (paymentId: string) => Promise<string[]>;
  loadRow: (invoiceId: string) => Promise<InvoiceRow>;
  invoiceSnapshot: (row: InvoiceRow) => Promise<Omit<InvoiceSnapshot, "amounts">>;
  creditNoteSnapshot: (row: InvoiceRow) => Promise<{ snapshot: Omit<CreditNoteSnapshot, "amounts">; invoiceTotalCents: number }>;
  storePdf: (path: string, pdf: Uint8Array) => Promise<void>;
  recordIssued: (row: InvoiceRow, r: IssueResult, pdfPath: string | null) => Promise<void>;
  recordFailed: (row: InvoiceRow, code: string) => Promise<void>;
  /** invoice_issued e-mail (outbox key = document id); errors are logged, never fail the document */
  notifyIssued: (row: InvoiceRow) => Promise<void>;
  log: (message: string, data?: Record<string, unknown>) => void;
};

export type IssueOutcome = "issued" | "already_issued" | "failed";

export const pdfPathFor = (row: Pick<InvoiceRow, "id" | "order_id">) => `${row.order_id}/${row.id}.pdf`;

/**
 * Issues one queued document (pending or failed). Never throws for provider / document errors (→ 'failed');
 * a database error while recording leaves the row pending for the cron and is rethrown.
 */
export async function issueQueued(deps: EInvoiceDeps, invoiceId: string): Promise<IssueOutcome> {
  const row = await deps.loadRow(invoiceId);
  if (row.status === "issued") return "already_issued";

  let result: IssueResult;
  try {
    if (row.provider !== deps.provider.name) throw new EInvoiceError("provider_mismatch");
    const company = await deps.company();
    const amounts = { netCents: row.net_cents, vatCents: row.vat_cents, totalCents: row.total_cents };
    if (row.kind === "invoice") {
      const doc = buildInvoiceDocument({ ...(await deps.invoiceSnapshot(row)), amounts }, company);
      result = await deps.provider.issueInvoice(doc, row.id);
    } else {
      const { snapshot, invoiceTotalCents } = await deps.creditNoteSnapshot(row);
      const doc = buildCreditNoteDocument({ ...snapshot, amounts }, company, invoiceTotalCents);
      result = await deps.provider.issueCreditNote(doc, row.id);
    }
  } catch (e) {
    const code = errorCode(e);
    deps.log("document not issued", { invoiceId: row.id, kind: row.kind, code });
    await deps.recordFailed(row, code);
    return "failed";
  }

  let pdfPath: string | null = null;
  if (result.pdf) {
    pdfPath = pdfPathFor(row);
    try {
      await deps.storePdf(pdfPath, result.pdf); // upsert: a retry overwrites the same file
    } catch (e) {
      deps.log("PDF not stored", { invoiceId: row.id, error: e instanceof Error ? e.message : String(e) });
      await deps.recordFailed(row, "pdf_store_failed"); // the retry gets the same number (same idempotency key)
      return "failed";
    }
  }
  await deps.recordIssued(row, result, pdfPath);

  try {
    await deps.notifyIssued(row);
  } catch (e) {
    deps.log("invoice e-mail failed", { invoiceId: row.id, error: e instanceof Error ? e.message : String(e) });
  }
  if (row.kind === "invoice") await creditNotesForPayment(deps, row.payment_id);
  return "issued";
}

/** The invoice of one payment, if the trigger says it is due (D147). */
export async function invoicePayment(deps: EInvoiceDeps, paymentId: string): Promise<IssueOutcome | "not_due"> {
  const facts = await deps.paymentFacts(paymentId);
  if (!facts || !invoiceDueFor(facts.payment, facts.order)) return "not_due";
  const { invoiceId } = await deps.queueInvoice(paymentId, deps.provider.name);
  return issueQueued(deps, invoiceId);
}

/** After `paid` (webhook): every succeeded payment of the order the trigger accepts. */
export async function invoiceOrder(deps: EInvoiceDeps, orderId: string): Promise<void> {
  for (const paymentId of await deps.orderPaymentIds(orderId)) await invoicePayment(deps, paymentId);
}

/** A credit note for a succeeded refund — or "waiting" until the invoice of its payment is issued (D146). */
export async function creditNoteForRefund(deps: EInvoiceDeps, refundId: string): Promise<IssueOutcome | "waiting"> {
  const q = await deps.queueCreditNote(refundId);
  if ("waiting" in q) return "waiting";
  return issueQueued(deps, q.invoiceId);
}

/** Notes that waited for this payment's invoice. */
async function creditNotesForPayment(deps: EInvoiceDeps, paymentId: string): Promise<void> {
  for (const refundId of await deps.refundsWithoutNote(paymentId)) {
    try {
      await creditNoteForRefund(deps, refundId);
    } catch (e) {
      deps.log("credit note not queued", { refundId, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/**
 * Runs a document task where a failure must never reach the caller (webhook, refund, admin action): errors are
 * logged; the cron catches up.
 */
export async function safely(deps: Pick<EInvoiceDeps, "log">, what: string, ids: Record<string, string>, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (e) {
    deps.log(`${what} failed`, { ...ids, error: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------------------
// Cron (catch-up)
// ---------------------------------------------------------------------------

/** Automatic retries of a failed document; then only the admin ("Riprova"). */
export const MAX_AUTO_ATTEMPTS = 5;
/** Wait after a failed attempt before the cron tries again. */
export const RETRY_AFTER_MS = 10 * 60_000;

export type CatchUpSources = {
  /** succeeded payments without an invoice row */
  paymentsWithoutInvoice: () => Promise<string[]>;
  /** pending rows, and failed rows with attempts < MAX_AUTO_ATTEMPTS whose last attempt is older than `before` */
  openDocuments: (before: Date) => Promise<string[]>;
  /** succeeded refunds without a note whose payment has an ISSUED invoice */
  refundsReadyForNote: () => Promise<string[]>;
};

export type CatchUpReport = { invoices: number; retried: number; creditNotes: number; failed: number; errors: number };

export async function catchUp(deps: EInvoiceDeps, src: CatchUpSources, now = new Date()): Promise<CatchUpReport> {
  const report: CatchUpReport = { invoices: 0, retried: 0, creditNotes: 0, failed: 0, errors: 0 };
  const count = (o: IssueOutcome | "not_due" | "waiting", key: "invoices" | "retried" | "creditNotes") => {
    if (o === "issued") report[key]++;
    else if (o === "failed") report.failed++;
  };
  const guard = async (ids: Record<string, string>, task: () => Promise<void>) => {
    try {
      await task();
    } catch (e) {
      report.errors++;
      deps.log("catch-up error", { ...ids, error: e instanceof Error ? e.message : String(e) });
    }
  };

  for (const paymentId of await src.paymentsWithoutInvoice()) {
    await guard({ paymentId }, async () => count(await invoicePayment(deps, paymentId), "invoices"));
  }
  for (const invoiceId of await src.openDocuments(new Date(now.getTime() - RETRY_AFTER_MS))) {
    await guard({ invoiceId }, async () => count(await issueQueued(deps, invoiceId), "retried"));
  }
  for (const refundId of await src.refundsReadyForNote()) {
    await guard({ refundId }, async () => count(await creditNoteForRefund(deps, refundId), "creditNotes"));
  }
  return report;
}
