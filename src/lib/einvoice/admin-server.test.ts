import { describe, expect, it, vi } from "vitest";
import type { AdminDeps } from "@/lib/admin/deps";
import { retryInvoice } from "./admin-server";
import { INVOICE_ADMIN_MSG } from "./view";

const ID = "33333333-3333-4333-8333-333333333333";
const deps = (error: { code: string; details?: string } | null) => {
  const rpc = vi.fn(() => ({ single: async () => ({ data: error ? null : { invoice_id: ID, newly_queued: true }, error }) }));
  return { d: { admin: { userId: "admin-1", email: "a@x" }, serviceDb: { rpc }, appUrl: "https://x" } as unknown as AdminDeps, rpc };
};

describe("retryInvoice", () => {
  it("puts the row back with the session's admin id, then issues", async () => {
    const { d, rpc } = deps(null);
    const issue = vi.fn(async () => "issued" as const);
    expect(await retryInvoice(d, { invoiceId: ID, adminId: "other" }, issue)).toEqual({ ok: true, message: INVOICE_ADMIN_MSG.retried });
    expect(rpc).toHaveBeenCalledWith("admin_retry_invoice", { p_invoice_id: ID, p_admin_id: "admin-1" });
    expect(issue).toHaveBeenCalledWith(d.serviceDb, ID);
  });

  it("maps the outcomes", async () => {
    expect(await retryInvoice(deps(null).d, { invoiceId: ID }, async () => "failed")).toEqual({ ok: false, error: INVOICE_ADMIN_MSG.retryFailed });
    expect(await retryInvoice(deps(null).d, { invoiceId: ID }, async () => "error")).toEqual({ ok: true, message: INVOICE_ADMIN_MSG.queued });
    expect(await retryInvoice(deps({ code: "55000", details: "already_issued" }).d, { invoiceId: ID }, async () => "issued")).toEqual({ ok: false, error: INVOICE_ADMIN_MSG.alreadyIssued });
    const issue = vi.fn();
    expect(await retryInvoice(deps(null).d, { invoiceId: "nope" }, issue)).toEqual({ ok: false, error: INVOICE_ADMIN_MSG.generic });
    expect(issue).not.toHaveBeenCalled();
  });
});
