import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";
import { activeCarrier, check, paidOrder, reviewOrder, run, setupJobContext, teardownJobContext, type DbError } from "./job-fixtures";

// Invoices and credit notes (D144–D150; migration 20261111180000_invoices.sql). On the real database: only the
// service role runs the functions; one invoice per accepted payment (also under concurrent calls); a credit note only
// after the invoice of its payment is issued (D146) and its amounts add up to the invoice; the DEMO series grows
// without gaps and never collides with a provider number (D145); 'issued' is final; sessions read their own
// documents without the technical columns; the PDF bucket follows the same rules.

let customer: TestUser;
let otherCustomer: TestUser;
let admin: TestUser;
let carrier: { user: TestUser; vehicleId: string };

const TOTAL = 19_520; // job-fixtures payload: net 16 000 + VAT 3 520
const VAT = 3_520;
const PDF = new TextEncoder().encode("%PDF-1.4\n%test\n");

type Queued = { invoice_id: string; newly_queued: boolean };

const mainPayment = async (orderId: string) =>
  (await check(service.from("payments").select("id").eq("order_id", orderId).eq("status", "succeeded").order("paid_at").limit(1).single())).id as string;
const queue = (paymentId: string, provider = "demo") => service.rpc("queue_invoice", { p_payment_id: paymentId, p_provider: provider }).single<Queued>();
const queueNote = (refundId: string) => service.rpc("queue_credit_note", { p_refund_id: refundId }).single<Queued>();
const reserve = (id: string) => service.rpc("reserve_demo_invoice_number", { p_invoice_id: id });
const record = (id: string, o: { ok: boolean; number?: string | null; pdf?: string | null; error?: string | null; sdi?: string }) =>
  service.rpc("record_invoice_result", {
    p_invoice_id: id, p_ok: o.ok, p_number: o.number ?? null, p_issued_at: o.ok ? new Date().toISOString() : null,
    p_provider_document_id: o.ok ? `doc-${id.slice(0, 8)}` : null, p_sdi_status: o.ok ? (o.sdi ?? "delivered") : null,
    p_pdf_path: o.pdf ?? null, p_error_code: o.error ?? null,
  });
const row = (id: string) => check(service.from("invoices").select("*").eq("id", id).single());

/** Issues a queued DEMO document the way the adapter does: reserve number → PDF → record. */
async function issueDemo(id: string): Promise<{ number: string; pdf: string }> {
  const r = await row(id);
  const number = (await check(reserve(id))) as string;
  const pdf = `${r.order_id}/${id}.pdf`;
  await run(service.storage.from("invoices").upload(pdf, PDF, { contentType: "application/pdf", upsert: true }));
  await check(record(id, { ok: true, number, pdf }));
  return { number, pdf };
}

/** A paid order with an issued DEMO invoice. */
async function invoicedOrder(): Promise<{ orderId: string; paymentId: string; invoiceId: string }> {
  const orderId = await paidOrder();
  const paymentId = await mainPayment(orderId);
  const { invoice_id } = await check(queue(paymentId));
  await issueDemo(invoice_id);
  return { orderId, paymentId, invoiceId: invoice_id };
}

/** A succeeded refund (admin partial refund + Stripe result). */
async function succeededRefund(orderId: string, amount: number): Promise<string> {
  const r = await check(service.rpc("admin_refund_order", { p_order_id: orderId, p_admin_id: admin.id, p_amount_cents: amount, p_reason_code: "goodwill" })
    .single<{ refund_id: string }>());
  await check(service.rpc("record_refund_result", { p_refund_id: r.refund_id, p_stripe_refund_id: `re_${randomUUID()}`, p_status: "succeeded" }));
  return r.refund_id;
}

beforeAll(async () => {
  const ctx = await setupJobContext();
  customer = ctx.customer;
  admin = ctx.admin;
  carrier = await activeCarrier("van_medium", 1200);
  otherCustomer = await createUser({});
  await run(service.from("customers").insert({ profile_id: otherCustomer.id, customer_type: "private" }));
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("who may call", () => {
  it("sessions cannot execute the write functions nor write the tables", async () => {
    const orderId = await paidOrder();
    const paymentId = await mainPayment(orderId);
    const id = randomUUID();
    for (const client of [anon, customer.client, carrier.user.client, admin.client]) {
      const calls = await Promise.all([
        client.rpc("queue_invoice", { p_payment_id: paymentId, p_provider: "demo" }),
        client.rpc("queue_credit_note", { p_refund_id: id }),
        client.rpc("reserve_demo_invoice_number", { p_invoice_id: id }),
        client.rpc("record_invoice_result", { p_invoice_id: id, p_ok: false, p_number: null, p_issued_at: null, p_provider_document_id: null, p_sdi_status: null, p_pdf_path: null, p_error_code: "x" }),
        client.rpc("record_invoice_sdi_status", { p_invoice_id: id, p_sdi_status: "sent" }),
        client.rpc("admin_retry_invoice", { p_invoice_id: id, p_admin_id: admin.id }),
      ]);
      for (const r of calls) expect((r.error as DbError)?.code).toBe("42501");
      const ins = await client.from("invoices").insert({ kind: "invoice", order_id: orderId, payment_id: paymentId, provider: "demo", is_demo: true, net_cents: 1, vat_cents: 0, total_cents: 1 });
      expect((ins.error as DbError)?.code).toBe("42501");
      expect((await client.from("invoice_demo_counters").select("*")).error).not.toBeNull();
    }
    // Even the service role writes only through the functions.
    expect((await service.from("invoices").insert({ kind: "invoice", order_id: orderId, payment_id: paymentId, provider: "demo", is_demo: true, net_cents: 1, vat_cents: 0, total_cents: 1 })).error).toMatchObject({ code: "42501" });
    expect(await check(service.from("invoices").select("id").eq("order_id", orderId))).toEqual([]);
  });

  it("admin_invoice_errors: only an admin session", async () => {
    const { orderId } = await invoicedOrder();
    for (const client of [customer.client, carrier.user.client]) {
      expect((await client.rpc("admin_invoice_errors", { p_order_id: orderId })).error).toMatchObject({ code: "42501" });
    }
    expect((await anon.rpc("admin_invoice_errors", { p_order_id: orderId })).error).not.toBeNull();
    const rows = await check(admin.client.rpc("admin_invoice_errors", { p_order_id: orderId }));
    expect(rows).toEqual([expect.objectContaining({ attempts: 1, last_error_code: null })]);
  });

  it("admin_retry_invoice refuses a blocked admin or a customer id", async () => {
    const orderId = await paidOrder();
    const { invoice_id } = await check(queue(await mainPayment(orderId)));
    await check(record(invoice_id, { ok: false, error: "provider_down" }));
    const blocked = await createUser({});
    await run(service.from("profiles").update({ role: "admin", is_blocked: true }).eq("id", blocked.id));
    for (const adminId of [blocked.id, customer.id]) {
      expect((await service.rpc("admin_retry_invoice", { p_invoice_id: invoice_id, p_admin_id: adminId })).error).toMatchObject({ code: "42501" });
    }
    expect((await row(invoice_id)).status).toBe("failed");
  });
});

describe("what sessions read", () => {
  it("the customer reads its own documents without technical columns; another customer and the carrier nothing", async () => {
    const { orderId, invoiceId } = await invoicedOrder();
    expect(await check(customer.client.from("invoices").select("id, kind, status, number, total_cents").eq("order_id", orderId)))
      .toEqual([expect.objectContaining({ id: invoiceId, kind: "invoice", status: "issued", total_cents: TOTAL })]);
    for (const col of ["provider_document_id", "attempts", "last_error_code", "last_attempt_at"]) {
      expect((await customer.client.from("invoices").select(col).eq("order_id", orderId)).error).toMatchObject({ code: "42501" });
      expect((await admin.client.from("invoices").select(col).eq("order_id", orderId)).error).toMatchObject({ code: "42501" });
    }
    for (const c of [otherCustomer, carrier.user]) {
      expect(await check(c.client.from("invoices").select("id").eq("order_id", orderId))).toEqual([]);
    }
    expect((await anon.from("invoices").select("id").eq("order_id", orderId)).error).not.toBeNull();
    expect(await check(admin.client.from("invoices").select("id").eq("order_id", orderId))).toEqual([{ id: invoiceId }]);
  });

  it("PDF: the customer of the order and the admin get a signed URL; others not; nobody uploads with a session", async () => {
    const { invoiceId } = await invoicedOrder();
    const { pdf_path } = await row(invoiceId);
    expect((await customer.client.storage.from("invoices").createSignedUrl(pdf_path, 60)).error).toBeNull();
    expect((await admin.client.storage.from("invoices").createSignedUrl(pdf_path, 60)).error).toBeNull();
    for (const c of [otherCustomer.client, carrier.user.client, anon]) {
      expect((await c.storage.from("invoices").createSignedUrl(pdf_path, 60)).error).not.toBeNull();
    }
    for (const c of [customer.client, admin.client]) {
      expect((await c.storage.from("invoices").upload(`${randomUUID()}/${randomUUID()}.pdf`, PDF, { contentType: "application/pdf" })).error).not.toBeNull();
    }
  });

  it("a PDF of a document that is not issued is not readable by the customer", async () => {
    const orderId = await paidOrder();
    const { invoice_id } = await check(queue(await mainPayment(orderId)));
    const path = `${orderId}/${invoice_id}.pdf`;
    await run(service.storage.from("invoices").upload(path, PDF, { contentType: "application/pdf" }));
    expect((await customer.client.storage.from("invoices").createSignedUrl(path, 60)).error).not.toBeNull();
  });
});

describe("queue_invoice", () => {
  it("one invoice per payment, also under concurrent calls; amounts from order_charges", async () => {
    const orderId = await paidOrder();
    const paymentId = await mainPayment(orderId);
    const results = await Promise.all(Array.from({ length: 5 }, () => queue(paymentId)));
    for (const r of results) expect(r.error).toBeNull();
    const ids = new Set(results.map((r) => r.data!.invoice_id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.data!.newly_queued)).toHaveLength(1);
    const inv = await row([...ids][0]);
    expect(inv).toMatchObject({ kind: "invoice", status: "pending", provider: "demo", is_demo: true, net_cents: 16_000, vat_cents: VAT, total_cents: TOTAL, number: null, attempts: 0 });
    // A later call with another provider returns the same row (the server checks the provider).
    expect((await check(queue(paymentId, "fatture_in_cloud"))).invoice_id).toBe(inv.id);
  });

  it("refuses an unknown provider and a payment that is not accepted", async () => {
    const orderId = await paidOrder();
    expect((await queue(await mainPayment(orderId), "acme")).error).toMatchObject({ code: "22023", details: "provider" });
    expect((await queue(randomUUID())).error).toMatchObject({ code: "22023", details: "payment" });
    const { paymentId } = await reviewOrder();
    expect((await queue(paymentId)).error).toMatchObject({ code: "55000", details: "payment_not_accepted" });
  });
});

describe("record_invoice_result", () => {
  it("failed → attempts + 1 and error code; then issued is final", async () => {
    const orderId = await paidOrder();
    const { invoice_id } = await check(queue(await mainPayment(orderId)));
    expect(await check(record(invoice_id, { ok: false, error: "provider_timeout" }))).toBe(true);
    expect(await row(invoice_id)).toMatchObject({ status: "failed", attempts: 1, last_error_code: "provider_timeout" });
    expect((await record(invoice_id, { ok: false })).error).toMatchObject({ code: "22023", details: "result" });

    const { number } = await issueDemo(invoice_id);
    expect(await row(invoice_id)).toMatchObject({ status: "issued", number, attempts: 2, last_error_code: null, sdi_status: "delivered" });
    expect(await check(record(invoice_id, { ok: false, error: "late" }))).toBe(false);
    expect(await check(record(invoice_id, { ok: true, number: "OTHER-1" }))).toBe(false);
    expect((await row(invoice_id)).number).toBe(number);
  });

  it("a reserved DEMO number must match; the PDF path must be {order}/{id}.pdf", async () => {
    const orderId = await paidOrder();
    const { invoice_id } = await check(queue(await mainPayment(orderId)));
    await check(reserve(invoice_id));
    expect((await record(invoice_id, { ok: true, number: "DEMO-1900-9999" })).error).toMatchObject({ code: "55000", details: "number_mismatch" });
    const number = (await row(invoice_id)).number;
    expect((await record(invoice_id, { ok: true, number, pdf: `${orderId}/${randomUUID()}.pdf` })).error).not.toBeNull();
    expect((await row(invoice_id)).status).toBe("pending");
  });

  it("issued documents: only the SDI status changes, through its function", async () => {
    const { invoiceId } = await invoicedOrder();
    expect(await check(service.rpc("record_invoice_sdi_status", { p_invoice_id: invoiceId, p_sdi_status: "rejected" }))).toBe(true);
    expect(await check(service.rpc("record_invoice_sdi_status", { p_invoice_id: invoiceId, p_sdi_status: "rejected" }))).toBe(false);
    expect((await row(invoiceId)).sdi_status).toBe("rejected");
    const orderId = await paidOrder();
    const { invoice_id } = await check(queue(await mainPayment(orderId)));
    expect((await service.rpc("record_invoice_sdi_status", { p_invoice_id: invoice_id, p_sdi_status: "sent" })).error).toMatchObject({ code: "55000", details: "not_issued" });
  });
});

describe("DEMO numbering (D145)", () => {
  it("reserved once per row, without gaps under concurrency; series per kind; refused for a real provider", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const orderId = await paidOrder();
      ids.push((await check(queue(await mainPayment(orderId)))).invoice_id);
    }
    const results = await Promise.all([...ids, ...ids].map((id) => reserve(id)));
    for (const r of results) expect(r.error).toBeNull();
    const byId = new Map<string, Set<string>>();
    results.forEach((r, i) => byId.set([...ids, ...ids][i], (byId.get([...ids, ...ids][i]) ?? new Set()).add(r.data as string)));
    for (const set of byId.values()) expect(set.size).toBe(1); // the same number on a retry
    const numbers = ids.map((id) => [...byId.get(id)!][0]);
    const year = new Intl.DateTimeFormat("en", { timeZone: "Europe/Rome", year: "numeric" }).format(new Date());
    for (const n of numbers) expect(n).toMatch(new RegExp(`^DEMO-${year}-\\d{4}$`));
    const seq = numbers.map((n) => Number(n.slice(-4))).sort((a, b) => a - b);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBe(seq[i - 1] + 1);

    const fic = await paidOrder();
    const ficId = (await check(queue(await mainPayment(fic), "fatture_in_cloud"))).invoice_id;
    expect((await reserve(ficId)).error).toMatchObject({ code: "55000", details: "not_demo" });
    // A provider number equal to a DEMO number does not collide (unique per provider).
    expect(await check(record(ficId, { ok: true, number: numbers[0] }))).toBe(true);
    expect(await row(ficId)).toMatchObject({ is_demo: false, number: numbers[0], status: "issued" });
  });
});

describe("credit notes (D146)", () => {
  it("wait for the invoice: pending / failed → invoice_not_issued; issued → one note", async () => {
    const orderId = await paidOrder();
    const paymentId = await mainPayment(orderId);
    const refundId = await succeededRefund(orderId, 5_000);
    expect((await queueNote(refundId)).error).toMatchObject({ code: "55000", details: "invoice_not_issued" }); // no invoice yet

    const { invoice_id } = await check(queue(paymentId));
    expect((await queueNote(refundId)).error).toMatchObject({ code: "55000", details: "invoice_not_issued" }); // pending
    await check(record(invoice_id, { ok: false, error: "provider_down" }));
    expect((await queueNote(refundId)).error).toMatchObject({ code: "55000", details: "invoice_not_issued" }); // failed
    expect(await check(service.from("invoices").select("id").eq("kind", "credit_note").eq("order_id", orderId))).toEqual([]);

    await issueDemo(invoice_id);
    const results = await Promise.all([queueNote(refundId), queueNote(refundId), queueNote(refundId)]);
    for (const r of results) expect(r.error).toBeNull();
    expect(new Set(results.map((r) => r.data!.invoice_id)).size).toBe(1);
    expect(results.filter((r) => r.data!.newly_queued)).toHaveLength(1);
    const note = await row(results[0].data!.invoice_id);
    expect(note).toMatchObject({ kind: "credit_note", invoice_id, refund_id: refundId, payment_id: paymentId, provider: "demo", total_cents: 5_000 });

    const number = (await check(reserve(note.id))) as string;
    expect(number).toMatch(/^DEMO-NC-\d{4}-\d{4}$/);
  });

  it("a refund that is not succeeded is refused", async () => {
    const { orderId } = await invoicedOrder();
    const r = await check(service.rpc("admin_refund_order", { p_order_id: orderId, p_admin_id: admin.id, p_amount_cents: 100, p_reason_code: "goodwill" }).single<{ refund_id: string }>());
    expect((await queueNote(r.refund_id)).error).toMatchObject({ code: "55000", details: "refund_not_succeeded" });
    expect((await queueNote(randomUUID())).error).toMatchObject({ code: "22023", details: "refund" });
  });

  it("amounts: cumulative VAT round half up — the notes add up exactly to the invoice (same examples as TS)", async () => {
    const { orderId } = await invoicedOrder();
    // 3 333 × 3 520 / 19 520 = 601.04… → 601; cumulative 6 666 → 1 202.08… → 1 202 (+601); rest 12 854 → 3 520 (+2 318)
    const parts = [3_333, 3_333, TOTAL - 6_666];
    const expected = [[3_333 - 601, 601], [3_333 - 601, 601], [TOTAL - 6_666 - 2_318, 2_318]];
    for (let i = 0; i < parts.length; i++) {
      const refundId = await succeededRefund(orderId, parts[i]);
      const note = await row((await check(queueNote(refundId))).invoice_id);
      expect([note.net_cents, note.vat_cents]).toEqual(expected[i]);
    }
    const notes = await check(service.from("invoices").select("net_cents, vat_cents, total_cents").eq("order_id", orderId).eq("kind", "credit_note"));
    expect(notes.reduce((s, n) => s + n.vat_cents, 0)).toBe(VAT);
    expect(notes.reduce((s, n) => s + n.total_cents, 0)).toBe(TOTAL);
  });
});

describe("admin_retry_invoice", () => {
  it("failed → pending once (audit without free text); pending → same row; issued → already_issued", async () => {
    const orderId = await paidOrder();
    const { invoice_id } = await check(queue(await mainPayment(orderId)));
    const retry = () => service.rpc("admin_retry_invoice", { p_invoice_id: invoice_id, p_admin_id: admin.id }).single<Queued>();
    expect(await check(retry())).toEqual({ invoice_id, newly_queued: false });
    await check(record(invoice_id, { ok: false, error: "provider_down" }));
    expect(await check(retry())).toEqual({ invoice_id, newly_queued: true });
    expect(await check(retry())).toEqual({ invoice_id, newly_queued: false });
    expect((await row(invoice_id)).status).toBe("pending");
    const audit = await check(service.from("audit_log").select("action, actor_id, data").eq("entity_id", invoice_id));
    expect(audit).toEqual([{ action: "invoice.retried", actor_id: admin.id, data: { order_id: orderId, kind: "invoice", attempts: 1, last_error_code: "provider_down" } }]);
    await issueDemo(invoice_id);
    expect((await retry()).error).toMatchObject({ code: "55000", details: "already_issued" });
  });
});
