import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Defer } from "../notifications/email";
import { sendEmail } from "../notifications/email";
import { INVOICE_ISSUED_TEMPLATE, renderInvoiceIssuedEmail } from "../notifications/templates/invoice-issued";
import { toCompanyInfo, type CompanyRow } from "../public/company";
import { getAppUrl } from "../supabase/env";
import { getEInvoiceProvider } from "./index";
import {
  catchUp,
  creditNoteForRefund,
  invoiceOrder,
  invoicePayment,
  issueQueued,
  MAX_AUTO_ATTEMPTS,
  safely,
  type CatchUpReport,
  type CatchUpSources,
  type EInvoiceDeps,
  type InvoiceRow,
} from "./flow";
import type { EInvoiceProvider } from "./provider";

// Real dependencies of the document flow (./flow.ts). `db` is the service-role client — called only by the Stripe
// webhook, by server code after an admin / customer action checked in the session, and by the cron.
// Entry points never throw: a document problem must not break a payment, a refund or an admin decision.

const ROW_COLUMNS = "id, kind, order_id, payment_id, refund_id, invoice_id, provider, status, number, net_cents, vat_cents, total_cents";
const log = (message: string, data?: Record<string, unknown>) => console.error(`[einvoice] ${message}`, data ?? {}); // ids and codes only

async function must<T>(p: PromiseLike<{ data: T; error: { message: string; code?: string; details?: string } | null }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error || data == null) throw new Error(`${what}: ${error?.message ?? "not found"}`);
  return data as NonNullable<T>;
}

export function einvoiceDeps(db: SupabaseClient, provider: EInvoiceProvider = getEInvoiceProvider(db), appUrl: string = getAppUrl()): EInvoiceDeps {
  return {
    provider,
    company: async () => toCompanyInfo(await must(db.from("settings").select("company_name, company_vat_number, company_street, company_city, company_postal_code, company_province, company_email, company_phone, company_pec").single<CompanyRow>(), "settings")),
    paymentFacts: async (paymentId) => {
      const { data, error } = await db.from("payments").select("purpose, status, review_reason, review_outcome, orders!inner(status)").eq("id", paymentId).maybeSingle();
      if (error) throw new Error(`payment: ${error.message}`);
      if (!data) return null;
      const { orders, ...payment } = data as unknown as EInvoicePaymentRow;
      return { payment, order: { status: orders.status } };
    },
    orderPaymentIds: async (orderId) =>
      (await must(db.from("payments").select("id").eq("order_id", orderId).eq("status", "succeeded").order("paid_at"), "payments")).map((p) => p.id as string),
    queueInvoice: async (paymentId, providerName) => {
      const r = await must(db.rpc("queue_invoice", { p_payment_id: paymentId, p_provider: providerName }).single<{ invoice_id: string; newly_queued: boolean }>(), "queue_invoice");
      return { invoiceId: r.invoice_id, newlyQueued: r.newly_queued };
    },
    queueCreditNote: async (refundId) => {
      const { data, error } = await db.rpc("queue_credit_note", { p_refund_id: refundId }).single<{ invoice_id: string; newly_queued: boolean }>();
      if (error?.code === "55000" && error.details === "invoice_not_issued") return { waiting: true };
      if (error || !data) throw new Error(`queue_credit_note: ${error?.details ?? error?.message ?? "no row"}`);
      return { invoiceId: data.invoice_id, newlyQueued: data.newly_queued };
    },
    refundsWithoutNote: async (paymentId) => {
      const refunds = await must(db.from("refunds").select("id").eq("payment_id", paymentId).eq("status", "succeeded"), "refunds");
      if (refunds.length === 0) return [];
      const notes = await must(db.from("invoices").select("refund_id").eq("payment_id", paymentId).eq("kind", "credit_note"), "notes");
      const done = new Set(notes.map((n) => n.refund_id));
      return refunds.map((r) => r.id as string).filter((id) => !done.has(id));
    },
    loadRow: (invoiceId) => must(db.from("invoices").select(ROW_COLUMNS).eq("id", invoiceId).single<InvoiceRow>(), "invoice"),
    invoiceSnapshot: async (row) => {
      const o = await must(db.from("orders").select("order_number, order_charges(customer_type, vat_rate_bp, subtotal_cents, vat_cents, total_cents, billing_details), order_lines(sort_order, label_it, quantity, net_cents, vat_cents, gross_cents)").eq("id", row.order_id).single(), "order");
      const pay = await must(db.from("payments").select("paid_at").eq("id", row.payment_id).single(), "payment");
      const order = o as unknown as OrderSnapshotRow;
      return { invoiceId: row.id, orderNumber: order.order_number, charges: order.order_charges, lines: order.order_lines, paidAt: new Date(pay.paid_at as string) };
    },
    creditNoteSnapshot: async (row) => {
      const o = (await must(db.from("orders").select("order_number, order_charges(customer_type, vat_rate_bp, subtotal_cents, vat_cents, total_cents, billing_details)").eq("id", row.order_id).single(), "order")) as unknown as OrderSnapshotRow;
      const inv = await must(db.from("invoices").select("number, issued_at, total_cents, status").eq("id", row.invoice_id!).single(), "invoice of the note");
      const refund = await must(db.from("refunds").select("updated_at").eq("id", row.refund_id!).single(), "refund");
      return {
        snapshot: { noteId: row.id, orderNumber: o.order_number, charges: o.order_charges, invoice: { number: inv.number as string, issuedAt: new Date(inv.issued_at as string) }, refundedAt: new Date(refund.updated_at as string) },
        invoiceTotalCents: inv.total_cents as number,
      };
    },
    storePdf: async (path, pdf) => {
      const { error } = await db.storage.from("invoices").upload(path, pdf, { contentType: "application/pdf", upsert: true });
      if (error) throw new Error(`storage: ${error.message}`);
    },
    recordIssued: async (row, r, pdfPath) => {
      const { error } = await db.rpc("record_invoice_result", {
        p_invoice_id: row.id, p_ok: true, p_number: r.number, p_issued_at: r.issuedAt.toISOString(), p_provider_document_id: r.providerDocumentId,
        p_sdi_status: r.sdiStatus, p_pdf_path: pdfPath, p_error_code: null,
      });
      if (error) throw new Error(`record_invoice_result: ${error.details ?? error.message}`);
    },
    recordFailed: async (row, code) => {
      const { error } = await db.rpc("record_invoice_result", {
        p_invoice_id: row.id, p_ok: false, p_number: null, p_issued_at: null, p_provider_document_id: null, p_sdi_status: null, p_pdf_path: null, p_error_code: code,
      });
      if (error) throw new Error(`record_invoice_result: ${error.details ?? error.message}`);
    },
    notifyIssued: (row) => sendInvoiceIssuedEmail(db, row, appUrl),
    log,
  };
}

type EInvoicePaymentRow = {
  purpose: "order" | "storage_extension";
  status: "pending" | "succeeded" | "expired" | "failed";
  review_reason: string | null;
  review_outcome: "accepted" | "refunded" | null;
  orders: { status: string };
};
type OrderSnapshotRow = {
  order_number: string;
  order_charges: { customer_type: "private" | "business"; vat_rate_bp: number; subtotal_cents: number; vat_cents: number; total_cents: number; billing_details: Record<string, unknown> };
  order_lines: { sort_order: number; label_it: string; quantity: number; net_cents: number; vat_cents: number; gross_cents: number }[];
};

/** "Fattura disponibile" / "Nota di credito disponibile" — link to /cliente/fatture, no attachment; once per document. */
async function sendInvoiceIssuedEmail(db: SupabaseClient, row: InvoiceRow, appUrl: string): Promise<void> {
  const issued = await must(db.from("invoices").select("number, total_cents, is_demo, orders!inner(order_number, customer_id)").eq("id", row.id).single(), "invoice");
  const order = (issued as unknown as { orders: { order_number: string; customer_id: string } }).orders;
  const profile = await must(db.from("profiles").select("email, first_name").eq("id", order.customer_id).single(), "profile");
  const rendered = renderInvoiceIssuedEmail({
    kind: row.kind,
    firstName: profile.first_name as string | null,
    number: issued.number as string,
    orderNumber: order.order_number,
    totalCents: issued.total_cents as number,
    isDemo: issued.is_demo as boolean,
    invoicesUrl: `${appUrl}/cliente/fatture`,
  });
  await sendEmail(db, { ...rendered, templateCode: INVOICE_ISSUED_TEMPLATE, to: profile.email as string, recipientId: order.customer_id, orderId: row.order_id, eventKey: row.id });
}

// ---------------------------------------------------------------------------
// Entry points (never throw)
// ---------------------------------------------------------------------------

/** Lazily built deps: a configuration error (e.g. DEMO on production) is logged, never thrown to the caller. */
function withDeps(db: SupabaseClient, what: string, ids: Record<string, string>, task: (deps: EInvoiceDeps) => Promise<unknown>, deps?: EInvoiceDeps): Promise<void> {
  return safely({ log }, what, ids, async () => task(deps ?? einvoiceDeps(db)));
}

/** Stripe webhook after `paid` (D147). With `defer` the provider runs after the response. */
export function invoiceAfterPaid(db: SupabaseClient, orderId: string, defer?: Defer, deps?: EInvoiceDeps): Promise<void> {
  const task = () => withDeps(db, "invoice after payment", { orderId }, (d) => invoiceOrder(d, orderId), deps);
  if (defer) {
    defer(task);
    return Promise.resolve();
  }
  return task();
}

/** "Segna come pagato" (D141). */
export function invoiceAcceptedPayment(db: SupabaseClient, paymentId: string, deps?: EInvoiceDeps): Promise<void> {
  return withDeps(db, "invoice after review", { paymentId }, (d) => invoicePayment(d, paymentId), deps);
}

/** After record_refund_result: a succeeded refund gets its credit note (or waits for the invoice, D146). */
export function creditNoteAfterRefund(db: SupabaseClient, refundId: string, status: string, deps?: EInvoiceDeps): Promise<void> {
  if (status !== "succeeded") return Promise.resolve();
  return withDeps(db, "credit note after refund", { refundId }, (d) => creditNoteForRefund(d, refundId), deps);
}

/** "Riprova" of the admin, after admin_retry_invoice() put the row back to pending. */
export async function issueDocumentNow(db: SupabaseClient, invoiceId: string, deps?: EInvoiceDeps): Promise<"issued" | "already_issued" | "failed" | "error"> {
  try {
    return await issueQueued(deps ?? einvoiceDeps(db), invoiceId);
  } catch (e) {
    log("retry failed", { invoiceId, error: e instanceof Error ? e.message : String(e) });
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export function catchUpSources(db: SupabaseClient): CatchUpSources {
  return {
    async paymentsWithoutInvoice() {
      const pays = await must(db.from("payments").select("id, review_reason, review_outcome").eq("status", "succeeded").eq("purpose", "order").limit(500), "payments");
      const candidates = pays.filter((p) => p.review_reason === null || p.review_outcome === "accepted").map((p) => p.id as string);
      if (candidates.length === 0) return [];
      const have = await must(db.from("invoices").select("payment_id").eq("kind", "invoice").in("payment_id", candidates), "invoices");
      const done = new Set(have.map((r) => r.payment_id));
      return candidates.filter((id) => !done.has(id));
    },
    async openDocuments(before) {
      const pending = await must(db.from("invoices").select("id").eq("status", "pending").lt("updated_at", before.toISOString()).order("created_at").limit(200), "pending");
      const failed = await must(db.from("invoices").select("id").eq("status", "failed").lt("attempts", MAX_AUTO_ATTEMPTS).lt("last_attempt_at", before.toISOString()).order("created_at").limit(200), "failed");
      return [...pending, ...failed].map((r) => r.id as string);
    },
    async refundsReadyForNote() {
      const issued = await must(db.from("invoices").select("payment_id").eq("kind", "invoice").eq("status", "issued"), "issued");
      const paymentIds = issued.map((r) => r.payment_id as string);
      if (paymentIds.length === 0) return [];
      const refunds = await must(db.from("refunds").select("id").eq("status", "succeeded").in("payment_id", paymentIds).limit(500), "refunds");
      if (refunds.length === 0) return [];
      const notes = await must(db.from("invoices").select("refund_id").eq("kind", "credit_note").in("refund_id", refunds.map((r) => r.id)), "notes");
      const done = new Set(notes.map((n) => n.refund_id));
      return refunds.map((r) => r.id as string).filter((id) => !done.has(id));
    },
  };
}

export async function runEInvoiceCatchUp(db: SupabaseClient, deps?: EInvoiceDeps): Promise<CatchUpReport> {
  return catchUp(deps ?? einvoiceDeps(db), catchUpSources(db));
}
