import { describe, expect, it } from "vitest";
import { toCompanyInfo } from "../public/company";
import { createDemoProvider } from "./demo";
import { catchUp, creditNoteForRefund, invoicePayment, issueQueued, RETRY_AFTER_MS, type EInvoiceDeps, type InvoiceRow } from "./flow";
import { EInvoiceError, type EInvoiceProvider } from "./provider";

// Orchestration of ./flow.ts with in-memory dependencies. The same paths on the real database:
// tests/rls/einvoice-flow.test.ts.

type World = {
  rows: Map<string, InvoiceRow & { attempts: number; last_error_code: string | null; pdf_path: string | null }>;
  pdfs: Map<string, Uint8Array>;
  mails: string[];
  refunds: { id: string; payment_id: string }[];
  calls: string[];
  failStore?: boolean;
};

const charges = { customer_type: "private" as const, vat_rate_bp: 2200, subtotal_cents: 16_000, vat_cents: 3_520, total_cents: 19_520, billing_details: { first_name: "Mario", last_name: "Rossi", fiscal_code: "RSSMRA80A01F205X" } };
const lines = [{ sort_order: 0, label_it: "Trasporto", quantity: 1, net_cents: 16_000, vat_cents: 3_520, gross_cents: 19_520 }];

function setup(opts: { provider?: (reserve: (id: string) => Promise<string>) => EInvoiceProvider } = {}) {
  const w: World = { rows: new Map(), pdfs: new Map(), mails: [], refunds: [], calls: [] };
  const numbers = new Map<string, string>();
  let n = 0;
  const reserve = async (id: string) => {
    if (!numbers.has(id)) numbers.set(id, `${w.rows.get(id)!.kind === "invoice" ? "DEMO" : "DEMO-NC"}-2026-${String(++n).padStart(4, "0")}`);
    return numbers.get(id)!;
  };
  const provider = opts.provider ? opts.provider(reserve) : createDemoProvider({ reserveNumber: reserve, env: {} });
  let seq = 0;
  const insert = (r: Partial<InvoiceRow> & Pick<InvoiceRow, "kind" | "payment_id" | "total_cents" | "vat_cents" | "net_cents">) => {
    const id = `00000000-0000-0000-0000-${String(++seq).padStart(12, "0")}`;
    w.rows.set(id, { id, order_id: "order-1", refund_id: null, invoice_id: null, provider: "demo", status: "pending", number: null, attempts: 0, last_error_code: null, pdf_path: null, ...r });
    return id;
  };
  const deps: EInvoiceDeps = {
    provider,
    company: async () => toCompanyInfo(null),
    paymentFacts: async (id) => (id === "pay-review" ? { payment: { purpose: "order", status: "succeeded", review_reason: "amount_mismatch", review_outcome: null }, order: { status: "payment_review" } } : { payment: { purpose: "order", status: "succeeded", review_reason: null, review_outcome: null }, order: { status: "paid" } }),
    orderPaymentIds: async () => ["pay-1"],
    queueInvoice: async (paymentId, prov) => {
      const existing = [...w.rows.values()].find((r) => r.kind === "invoice" && r.payment_id === paymentId);
      if (existing) return { invoiceId: existing.id, newlyQueued: false };
      return { invoiceId: insert({ kind: "invoice", payment_id: paymentId, provider: prov, net_cents: 16_000, vat_cents: 3_520, total_cents: 19_520 }), newlyQueued: true };
    },
    queueCreditNote: async (refundId) => {
      const refund = w.refunds.find((r) => r.id === refundId)!;
      const inv = [...w.rows.values()].find((r) => r.kind === "invoice" && r.payment_id === refund.payment_id);
      if (!inv || inv.status !== "issued") return { waiting: true };
      const existing = [...w.rows.values()].find((r) => r.refund_id === refundId);
      if (existing) return { invoiceId: existing.id, newlyQueued: false };
      return { invoiceId: insert({ kind: "credit_note", payment_id: refund.payment_id, refund_id: refundId, invoice_id: inv.id, net_cents: 4_100, vat_cents: 900, total_cents: 5_000 }), newlyQueued: true };
    },
    refundsWithoutNote: async (paymentId) => w.refunds.filter((r) => r.payment_id === paymentId && ![...w.rows.values()].some((x) => x.refund_id === r.id)).map((r) => r.id),
    loadRow: async (id) => ({ ...w.rows.get(id)! }),
    invoiceSnapshot: async (row) => ({ invoiceId: row.id, orderNumber: "TG-000001", charges, lines, paidAt: new Date() }),
    creditNoteSnapshot: async (row) => ({
      snapshot: { noteId: row.id, orderNumber: "TG-000001", charges, invoice: { number: w.rows.get(row.invoice_id!)!.number!, issuedAt: new Date() }, refundedAt: null },
      invoiceTotalCents: 19_520,
    }),
    storePdf: async (path, pdf) => {
      w.calls.push(`store:${path}`);
      if (w.failStore) throw new Error("storage down");
      w.pdfs.set(path, pdf);
    },
    recordIssued: async (row, r, pdfPath) => {
      w.calls.push(`issued:${row.id}`);
      const x = w.rows.get(row.id)!;
      if (x.status === "issued") return;
      Object.assign(x, { status: "issued", number: r.number, pdf_path: pdfPath, attempts: x.attempts + 1, last_error_code: null });
    },
    recordFailed: async (row, code) => {
      const x = w.rows.get(row.id)!;
      Object.assign(x, { status: "failed", attempts: x.attempts + 1, last_error_code: code });
    },
    notifyIssued: async (row) => {
      w.mails.push(row.id);
    },
    log: () => undefined,
  };
  return { w, deps };
}

const failing = (code: string, times = Infinity) => (reserve: (id: string) => Promise<string>): EInvoiceProvider => {
  const demo = createDemoProvider({ reserveNumber: reserve, env: {} });
  let left = times;
  return {
    ...demo,
    issueInvoice: async (doc, key) => {
      if (left-- > 0) throw new EInvoiceError(code);
      return demo.issueInvoice(doc, key);
    },
  };
};

describe("issuing an invoice", () => {
  it("pending → provider → PDF {order}/{id}.pdf → issued → e-mail", async () => {
    const { w, deps } = setup();
    expect(await invoicePayment(deps, "pay-1")).toBe("issued");
    const [row] = [...w.rows.values()];
    expect(row).toMatchObject({ status: "issued", number: "DEMO-2026-0001", pdf_path: `order-1/${row.id}.pdf`, attempts: 1 });
    expect(w.calls).toEqual([`store:order-1/${row.id}.pdf`, `issued:${row.id}`]);
    expect(w.mails).toEqual([row.id]);
    expect(await invoicePayment(deps, "pay-1")).toBe("already_issued");
    expect(w.mails).toHaveLength(1);
  });

  it("not due (payment in review) → nothing queued", async () => {
    const { w, deps } = setup();
    expect(await invoicePayment(deps, "pay-review")).toBe("not_due");
    expect(w.rows.size).toBe(0);
  });

  it("a provider error is recorded as failed with its code and never thrown; the retry issues with the same number", async () => {
    const { w, deps } = setup({ provider: failing("provider_timeout", 1) });
    expect(await invoicePayment(deps, "pay-1")).toBe("failed");
    const [row] = [...w.rows.values()];
    expect(row).toMatchObject({ status: "failed", attempts: 1, last_error_code: "provider_timeout" });
    expect(w.mails).toEqual([]);
    expect(await issueQueued(deps, row.id)).toBe("issued");
    expect(w.rows.get(row.id)).toMatchObject({ status: "issued", attempts: 2, last_error_code: null });
  });

  it("a PDF that cannot be stored → failed (pdf_store_failed); the retry keeps the number", async () => {
    const { w, deps } = setup();
    w.failStore = true;
    expect(await invoicePayment(deps, "pay-1")).toBe("failed");
    const [row] = [...w.rows.values()];
    expect(row).toMatchObject({ status: "failed", last_error_code: "pdf_store_failed", number: null });
    w.failStore = false;
    expect(await issueQueued(deps, row.id)).toBe("issued");
    expect(w.rows.get(row.id)!.number).toBe("DEMO-2026-0001"); // reserved on the first attempt, no gap
  });

  it("a row of another provider is not sent to this one (provider_mismatch)", async () => {
    const { w, deps } = setup();
    const { invoiceId } = await deps.queueInvoice("pay-1", "fatture_in_cloud");
    expect(await issueQueued(deps, invoiceId)).toBe("failed");
    expect(w.rows.get(invoiceId)!.last_error_code).toBe("provider_mismatch");
  });
});

describe("credit notes wait for the invoice (D146)", () => {
  it("refund before the invoice → waiting; issuing the invoice issues the waiting note", async () => {
    const { w, deps } = setup({ provider: failing("provider_down", 1) });
    w.refunds.push({ id: "ref-1", payment_id: "pay-1" });
    expect(await creditNoteForRefund(deps, "ref-1")).toBe("waiting");
    expect(await invoicePayment(deps, "pay-1")).toBe("failed");
    expect(await creditNoteForRefund(deps, "ref-1")).toBe("waiting"); // invoice failed → still no note
    expect([...w.rows.values()].filter((r) => r.kind === "credit_note")).toEqual([]);

    const inv = [...w.rows.values()][0];
    expect(await issueQueued(deps, inv.id)).toBe("issued");
    const notes = [...w.rows.values()].filter((r) => r.kind === "credit_note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ status: "issued", number: "DEMO-NC-2026-0002", refund_id: "ref-1" });
    expect(await creditNoteForRefund(deps, "ref-1")).toBe("already_issued");
  });
});

describe("catch-up (cron)", () => {
  it("missed payments, open documents and waiting notes", async () => {
    const { w, deps } = setup();
    w.refunds.push({ id: "ref-1", payment_id: "pay-1" });
    let seenBefore: Date | null = null;
    const now = new Date("2026-11-11T12:00:00Z");
    const report = await catchUp(deps, {
      paymentsWithoutInvoice: async () => ["pay-1", "pay-review"],
      openDocuments: async (before) => {
        seenBefore = before;
        return [];
      },
      refundsReadyForNote: async () => ["ref-1"], // already issued right after its invoice → not counted again
    }, now);
    expect(report).toEqual({ invoices: 1, retried: 0, creditNotes: 0, failed: 0, errors: 0 });
    expect(seenBefore).toEqual(new Date(now.getTime() - RETRY_AFTER_MS));
    expect([...w.rows.values()].map((r) => [r.kind, r.status])).toEqual([["invoice", "issued"], ["credit_note", "issued"]]);
  });

  it("one broken item is counted and the others still run", async () => {
    const { w, deps } = setup({ provider: failing("provider_down", 1) });
    const broken = { ...deps, queueInvoice: async (id: string, p: string) => (id === "pay-x" ? Promise.reject(new Error("db down")) : deps.queueInvoice(id, p)) };
    const report = await catchUp(broken, {
      paymentsWithoutInvoice: async () => ["pay-x", "pay-1"],
      openDocuments: async () => [...w.rows.keys()],
      refundsReadyForNote: async () => [],
    });
    expect(report).toEqual({ invoices: 0, retried: 1, creditNotes: 0, failed: 1, errors: 1 });
    expect([...w.rows.values()][0].status).toBe("issued");
  });
});
