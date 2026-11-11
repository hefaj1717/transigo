import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDemoProvider } from "@/lib/einvoice/demo";
import { catchUp } from "@/lib/einvoice/flow";
import { EInvoiceError, type EInvoiceProvider } from "@/lib/einvoice/provider";
import { catchUpSources, einvoiceDeps, invoiceAcceptedPayment, invoiceAfterPaid, issueDocumentNow } from "@/lib/einvoice/server";
import { INVOICE_ISSUED_TEMPLATE } from "@/lib/notifications/templates/invoice-issued";
import { recordRefundResult } from "@/lib/orders/refund-record";
import { deleteCreatedUsers, service, type TestUser } from "./helpers";
import { check, paidOrder, reviewOrder, setupJobContext, teardownJobContext } from "./job-fixtures";

// The document flow (src/lib/einvoice/server.ts + flow.ts) on the LOCAL database (D64): real functions, the DEMO
// adapter with the real number reservation, the private bucket and the e-mail outbox. Provider errors, retries with
// the same number, a credit note waiting for its invoice (D146), "Segna come pagato" and the cron sources.

let admin: TestUser;
const APP = "https://transigo.example";

const reserve = async (id: string) => (await check(service.rpc("reserve_demo_invoice_number", { p_invoice_id: id }))) as string;
const demo = () => createDemoProvider({ reserveNumber: reserve, env: {} });
const deps = (provider: EInvoiceProvider = demo()) => einvoiceDeps(service, provider, APP);

/** Reserves the number, then fails `times` times (like a provider timeout after accepting the document). */
function flaky(times: number): EInvoiceProvider {
  const d = demo();
  let left = times;
  const fail = async (key: string) => {
    if (left-- <= 0) return false;
    await reserve(key);
    throw new EInvoiceError("provider_timeout");
  };
  return {
    ...d,
    issueInvoice: async (doc, key) => ((await fail(key)) as never) || d.issueInvoice(doc, key),
    issueCreditNote: async (doc, key) => ((await fail(key)) as never) || d.issueCreditNote(doc, key),
  };
}

const docs = (orderId: string) =>
  check(service.from("invoices").select("id, kind, status, number, pdf_path, attempts, last_error_code, refund_id, total_cents, vat_cents").eq("order_id", orderId).order("created_at"));
const mainPayment = async (orderId: string) => (await check(service.from("payments").select("id").eq("order_id", orderId).eq("status", "succeeded").limit(1).single())).id as string;
const outbox = (orderId: string) => check(service.from("email_outbox").select("template_code, event_key").eq("order_id", orderId).eq("template_code", INVOICE_ISSUED_TEMPLATE));

async function succeededRefund(orderId: string, amount: number): Promise<string> {
  const r = await check(service.rpc("admin_refund_order", { p_order_id: orderId, p_admin_id: admin.id, p_amount_cents: amount, p_reason_code: "goodwill" }).single<{ refund_id: string }>());
  await recordRefundResult(service, r.refund_id, `re_${randomUUID()}`, "succeeded");
  return r.refund_id;
}

const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;

beforeAll(async () => {
  ({ admin } = await setupJobContext());
  process.env.NEXT_PUBLIC_APP_URL = APP; // recordRefundResult builds the real deps (link in the e-mail)
});

afterAll(async () => {
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("after payment (webhook)", () => {
  it("issues the DEMO invoice: number, PDF in the bucket, one e-mail; a second call changes nothing", async () => {
    const orderId = await paidOrder();
    await invoiceAfterPaid(service, orderId, undefined, deps());
    const [inv] = await docs(orderId);
    expect(inv).toMatchObject({ kind: "invoice", status: "issued", attempts: 1, last_error_code: null, pdf_path: `${orderId}/${inv.id}.pdf` });
    expect(inv.number).toMatch(/^DEMO-\d{4}-\d{4}$/);
    const file = await service.storage.from("invoices").download(inv.pdf_path!);
    expect(new TextDecoder().decode((await file.data!.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    expect(await outbox(orderId)).toEqual([{ template_code: INVOICE_ISSUED_TEMPLATE, event_key: inv.id }]);

    await invoiceAfterPaid(service, orderId, undefined, deps());
    expect(await docs(orderId)).toHaveLength(1);
    expect(await outbox(orderId)).toHaveLength(1);
  });

  it("a deferred call queues nothing before it runs; errors never reach the caller", async () => {
    const orderId = await paidOrder();
    const tasks: (() => Promise<void>)[] = [];
    await invoiceAfterPaid(service, orderId, (t) => tasks.push(t), deps());
    expect(await docs(orderId)).toEqual([]);
    await tasks[0]();
    expect((await docs(orderId))[0].status).toBe("issued");

    const broken = { ...deps(), company: async () => Promise.reject(new Error("settings down")) };
    const other = await paidOrder();
    await expect(invoiceAfterPaid(service, other, undefined, broken)).resolves.toBeUndefined();
    expect(await docs(other)).toEqual([expect.objectContaining({ status: "failed", last_error_code: "provider_error" })]);
  });
});

describe("provider errors and retries", () => {
  it("failed with a code; the admin retry issues with the SAME reserved number", async () => {
    const orderId = await paidOrder();
    await invoiceAfterPaid(service, orderId, undefined, deps(flaky(1)));
    const [failed] = await docs(orderId);
    expect(failed).toMatchObject({ status: "failed", attempts: 1, last_error_code: "provider_timeout", pdf_path: null });
    expect(failed.number).toMatch(/^DEMO-/); // reserved before the error
    expect(await outbox(orderId)).toEqual([]);

    await check(service.rpc("admin_retry_invoice", { p_invoice_id: failed.id, p_admin_id: admin.id }).single());
    expect(await issueDocumentNow(service, failed.id, deps())).toBe("issued");
    const [issued] = await docs(orderId);
    expect(issued).toMatchObject({ status: "issued", number: failed.number, attempts: 2, last_error_code: null });
    expect(await outbox(orderId)).toHaveLength(1);
  });

  it("the cron sources: a missed payment, a failed document after the wait, a note whose invoice is issued", async () => {
    const missed = await paidOrder();
    const missedPayment = await mainPayment(missed);
    const src = catchUpSources(service);
    expect(await src.paymentsWithoutInvoice()).toContain(missedPayment);

    const failedOrder = await paidOrder();
    await invoiceAfterPaid(service, failedOrder, undefined, deps(flaky(1)));
    const [failed] = await docs(failedOrder);
    expect(await src.openDocuments(new Date(Date.now() - 60_000))).not.toContain(failed.id); // tried a moment ago
    expect(await src.openDocuments(new Date(Date.now() + 60_000))).toContain(failed.id);

    // Run the catch-up on these items only (the local database holds the orders of the other test files).
    const report = await catchUp(deps(), {
      paymentsWithoutInvoice: async () => (await src.paymentsWithoutInvoice()).filter((id) => id === missedPayment),
      openDocuments: async (before) => (await src.openDocuments(new Date(before.getTime() + 20 * 60_000))).filter((id) => id === failed.id),
      refundsReadyForNote: async () => [],
    });
    expect(report).toEqual({ invoices: 1, retried: 1, creditNotes: 0, failed: 0, errors: 0 });
    expect((await docs(missed))[0].status).toBe("issued");
    expect((await docs(failedOrder))[0].status).toBe("issued");
    expect(await src.paymentsWithoutInvoice()).not.toContain(missedPayment);
  });

  it("five failed attempts → the cron stops; only the admin retries", async () => {
    const orderId = await paidOrder();
    await invoiceAfterPaid(service, orderId, undefined, deps(flaky(1)));
    const [row] = await docs(orderId);
    for (let i = 0; i < 4; i++) {
      await check(service.rpc("record_invoice_result", { p_invoice_id: row.id, p_ok: false, p_number: null, p_issued_at: null, p_provider_document_id: null, p_sdi_status: null, p_pdf_path: null, p_error_code: "provider_timeout" }));
    }
    expect((await docs(orderId))[0].attempts).toBe(5);
    expect(await catchUpSources(service).openDocuments(new Date(Date.now() + 3600_000))).not.toContain(row.id);
  });
});

describe("credit notes (D146)", () => {
  it("a refund before the invoice waits; issuing the invoice issues the note; amounts from the database", async () => {
    const orderId = await paidOrder();
    const refundId = await succeededRefund(orderId, 5_000); // recordRefundResult tries the note: no invoice yet
    expect(await docs(orderId)).toEqual([]);

    await invoiceAfterPaid(service, orderId, undefined, deps(flaky(1))); // the invoice fails
    expect((await docs(orderId)).map((d) => [d.kind, d.status])).toEqual([["invoice", "failed"]]);
    expect(await catchUpSources(service).refundsReadyForNote()).not.toContain(refundId);

    const [inv] = await docs(orderId);
    expect(await issueDocumentNow(service, inv.id, deps())).toBe("issued");
    const all = await docs(orderId);
    expect(all.map((d) => [d.kind, d.status])).toEqual([["invoice", "issued"], ["credit_note", "issued"]]);
    expect(all[1]).toMatchObject({ refund_id: refundId, total_cents: 5_000, vat_cents: 902 }); // 5 000 × 3 520 / 19 520 = 901.6 → 902
    expect(all[1].number).toMatch(/^DEMO-NC-\d{4}-\d{4}$/);
    expect(await outbox(orderId)).toHaveLength(2);
  });

  it("a refund after the invoice gets its note at once", async () => {
    const orderId = await paidOrder();
    await invoiceAfterPaid(service, orderId, undefined, deps());
    // recordRefundResult builds the real deps; the default provider is DEMO (EINVOICE_PROVIDER unset in tests).
    const refundId = await succeededRefund(orderId, 19_520);
    const notes = (await docs(orderId)).filter((d) => d.kind === "credit_note");
    expect(notes).toEqual([expect.objectContaining({ refund_id: refundId, status: "issued", total_cents: 19_520, vat_cents: 3_520 })]);
  });

  it("a pending or failed refund gets no note", async () => {
    const orderId = await paidOrder();
    await invoiceAfterPaid(service, orderId, undefined, deps());
    const r = await check(service.rpc("admin_refund_order", { p_order_id: orderId, p_admin_id: admin.id, p_amount_cents: 100, p_reason_code: "goodwill" }).single<{ refund_id: string }>());
    await recordRefundResult(service, r.refund_id, `re_${randomUUID()}`, "failed");
    expect((await docs(orderId)).filter((d) => d.kind === "credit_note")).toEqual([]);
  });
});

describe("Segna come pagato (D141)", () => {
  it("no invoice while in review; the accepted payment gets it", async () => {
    const { orderId, paymentId } = await reviewOrder();
    await invoiceAcceptedPayment(service, paymentId, deps());
    expect(await docs(orderId)).toEqual([]);
    await check(service.rpc("admin_resolve_payment_review", { p_payment_id: paymentId, p_admin_id: admin.id, p_action: "mark_paid" }).single());
    await invoiceAcceptedPayment(service, paymentId, deps());
    expect((await docs(orderId)).map((d) => [d.kind, d.status])).toEqual([["invoice", "issued"]]);
  });
});
