import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail, type Defer } from "@/lib/notifications/email";
import {
  CANCELLATION_REQUESTED_TEMPLATE,
  CARRIER_JOB_CANCELLED_TEMPLATE,
  ORDER_CANCELLED_TEMPLATE,
  renderCancellationRequestedEmail,
  renderCarrierJobCancelledEmail,
  renderOrderCancelledEmail,
} from "@/lib/notifications/templates/order-cancellation";
import { getStripe } from "@/lib/stripe/server";
import { refundStatusFromStripe, type RefundStatus } from "./cancellation";
import { recordRefundResult } from "./refund-record";
import { ORDER_SUMMARY_SELECT, toOrderSummary, type OrderSummaryRow } from "./order-summary";
import { chainParts, type GroupMemberRow } from "./order-group";
import { loadOrderGroup } from "./order-group-server";

// Customer cancellation of a paid order (D33, D137). Order of operations:
//   1. customer_cancel_order() in the database — status, fee and the pending refund row, atomically (the amount is
//      computed there, never here);
//   2. the Stripe Refund for that row (idempotency key = the row id, so a retry never refunds twice);
//   3. record_refund_result() with Stripe's answer — a later outcome arrives through the webhook (refund.updated).
// A Stripe or recording error never undoes the cancellation: the refund stays pending and the admin retries it
// (step 3). E-mails go after the response; their failure is only logged.
// `db` is the service-role client, used only after the Server Action checked the customer session (DAL).

export type CancelRow = {
  result: "cancelled" | "review" | "already_cancelled" | "already_in_review";
  fee_cents: number | null;
  refund_cents: number | null;
  refund_id: string | null;
  payment_intent_id: string | null;
  order_number: string;
  /** One refund row per order of a storage chain (D169); refund_id = the first. */
  refund_ids?: string[] | null;
};

export type RefundRow = { id: string; order_id: string; amount_cents: number };

export type CancellationDeps = {
  cancelInDb: (orderId: string, customerId: string, reason: string | null) => Promise<{ data: CancelRow | null; error: { code?: string; details?: string; message?: string } | null }>;
  createStripeRefund: (a: { refundId: string; orderId: string; paymentIntentId: string; amountCents: number }) => Promise<{ id: string; status: string | null }>;
  recordRefund: (refundId: string, stripeRefundId: string | null, status: RefundStatus) => Promise<void>;
  /** Amounts of the refund rows of a chain cancellation (written by the database, never computed here). */
  loadRefunds: (refundIds: string[]) => Promise<RefundRow[]>;
  /** E-mails after the response (customer for a cancellation; admin + carrier for a request). */
  notify: (kind: "cancelled" | "review", orderId: string) => void;
  log: (message: string, data?: Record<string, unknown>) => void;
};

export const CANCEL_MSG = {
  notFound: "Ordine non trovato.",
  notCancellable: "Questo ordine non può più essere annullato online. Contattaci.",
  groupInProgress: "Un trasporto collegato a questo deposito è già stato preso in carico: per annullare contattaci.",
  storageStarted: "Il deposito è già iniziato: per annullarlo o modificarlo contattaci.",
  generic: "Non è stato possibile annullare l'ordine. Riprova tra qualche minuto.",
} as const;

export type CancelOutcome =
  | { ok: true; kind: "cancelled"; feeCents: number; refundCents: number; refund: RefundStatus | "none" }
  | { ok: true; kind: "already_cancelled" | "review" | "already_in_review" }
  | { ok: false; message: string };

export async function cancelOrderForCustomer(deps: CancellationDeps, customerId: string, orderId: string, reason: string | null): Promise<CancelOutcome> {
  const { data, error } = await deps.cancelInDb(orderId, customerId, reason);
  if (error || !data) {
    if (error?.details === "order") return { ok: false, message: CANCEL_MSG.notFound };
    if (error?.details === "not_cancellable") return { ok: false, message: CANCEL_MSG.notCancellable };
    if (error?.details === "group_in_progress") return { ok: false, message: CANCEL_MSG.groupInProgress };
    if (error?.details === "storage_started") return { ok: false, message: CANCEL_MSG.storageStarted };
    deps.log("customer_cancel_order failed", { orderId, code: error?.code, details: error?.details });
    return { ok: false, message: CANCEL_MSG.generic };
  }

  if (data.result === "review") {
    deps.notify("review", orderId);
    return { ok: true, kind: "review" };
  }
  if (data.result !== "cancelled") return { ok: true, kind: data.result };

  const feeCents = data.fee_cents ?? 0;
  const refundCents = data.refund_cents ?? 0;
  let refund: RefundStatus | "none" = "none";
  let rows: RefundRow[] = [];
  if (data.refund_ids && data.refund_ids.length > 1) {
    try {
      rows = await deps.loadRefunds(data.refund_ids);
    } catch (e) {
      // The cancellation stands; the rows stay pending for the admin ("Riprova").
      deps.log("refund rows not loaded", { orderId, error: e instanceof Error ? e.message : String(e) });
      refund = "pending";
    }
  } else if (data.refund_id && refundCents > 0) {
    rows = [{ id: data.refund_id, order_id: orderId, amount_cents: refundCents }];
  }
  for (const row of rows) {
    let status: RefundStatus = "pending";
    try {
      if (!data.payment_intent_id) throw new Error("payment without payment_intent_id");
      const r = await deps.createStripeRefund({ refundId: row.id, orderId: row.order_id, paymentIntentId: data.payment_intent_id, amountCents: row.amount_cents });
      status = refundStatusFromStripe(r.status);
      await deps.recordRefund(row.id, r.id, status);
    } catch (e) {
      // The cancellation stands; the refund row stays pending for the admin (and the webhook, if Stripe got it).
      deps.log("refund not completed", { orderId, refundId: row.id, error: e instanceof Error ? e.message : String(e) });
    }
    refund = worse(refund, status);
  }
  deps.notify("cancelled", orderId);
  return { ok: true, kind: "cancelled", feeCents, refundCents, refund };
}

/** Several refunds (a chain): the customer sees the worst outcome — failed, then pending, then succeeded. */
function worse(a: RefundStatus | "none", b: RefundStatus): RefundStatus {
  const rank: Record<RefundStatus, number> = { succeeded: 0, pending: 1, failed: 2 };
  return a === "none" || rank[b] > rank[a] ? b : a;
}

// ---------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------

export function cancellationDeps(db: SupabaseClient, opts: { appUrl: string; adminEmail: string | null; defer: Defer }): CancellationDeps {
  const log = (message: string, data?: Record<string, unknown>) => console.error(`[cancellation] ${message}`, data ?? {});
  return {
    cancelInDb: async (orderId, customerId, reason) => {
      const { data, error } = await db.rpc("customer_cancel_order", { p_order_id: orderId, p_customer_id: customerId, p_reason: reason }).single<CancelRow>();
      return { data, error };
    },
    createStripeRefund: ({ refundId, orderId, paymentIntentId, amountCents }) =>
      getStripe().refunds.create(
        { payment_intent: paymentIntentId, amount: amountCents, reason: "requested_by_customer", metadata: { refund_id: refundId, order_id: orderId } },
        { idempotencyKey: `refund:${refundId}` },
      ),
    recordRefund: async (refundId, stripeRefundId, status) => {
      await recordRefundResult(db, refundId, stripeRefundId, status);
    },
    loadRefunds: async (ids) => {
      const { data, error } = await db.from("refunds").select("id, order_id, amount_cents").in("id", ids);
      if (error) throw new Error(`refunds: ${error.message}`);
      const rows = (data ?? []) as RefundRow[];
      return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is RefundRow => !!r);
    },
    notify: (kind, orderId) =>
      opts.defer(async () => {
        try {
          if (kind === "cancelled") await sendOrderCancelledEmail(db, orderId, opts.appUrl);
          else await sendCancellationRequestEmails(db, orderId, opts.appUrl, opts.adminEmail);
        } catch (e) {
          log("e-mail not queued", { orderId, kind, error: e instanceof Error ? e.message : String(e) });
        }
      }),
    log,
  };
}

async function loadOrder(db: SupabaseClient, orderId: string) {
  const { data: o, error } = await db
    .from("orders")
    .select(`id, order_number, customer_id, carrier_id, order_charges(cancellation_fee_cents), ${ORDER_SUMMARY_SELECT}`)
    .eq("id", orderId)
    .single();
  if (error || !o) throw new Error(`order for e-mail: ${error?.message ?? "not found"}`);
  return { o, summary: toOrderSummary(o as OrderSummaryRow) };
}

type CancelledEmailRow = GroupMemberRow & OrderSummaryRow & { customer_id: string; order_charges: { cancellation_fee_cents: number | null } | null };

/** One e-mail per cancellation; a storage chain (cancelled as a whole, D169) gets one e-mail on its root with the sums. */
export async function sendOrderCancelledEmail(db: SupabaseClient, orderId: string, appUrl: string): Promise<void> {
  const group = await loadOrderGroup<CancelledEmailRow>(db, orderId, `customer_id, order_charges(cancellation_fee_cents), ${ORDER_SUMMARY_SELECT}`);
  if (!group) throw new Error("order for e-mail: not found");
  const o = group.root;
  const ids = group.members.map((m) => m.id);
  const [{ data: profile }, { data: refunds }] = await Promise.all([
    db.from("profiles").select("email, first_name").eq("id", o.customer_id).single(),
    db.from("refunds").select("amount_cents, status").in("order_id", ids).eq("kind", "customer_cancellation"),
  ]);
  if (!profile?.email) throw new Error("customer e-mail not found");
  const refundCents = (refunds ?? []).filter((r) => r.status !== "failed").reduce((s, r) => s + r.amount_cents, 0);
  const feeCents = group.members.reduce((s, m) => s + (m.order_charges?.cancellation_fee_cents ?? 0), 0);
  const rendered = renderOrderCancelledEmail({
    firstName: profile.first_name,
    orderNumber: o.order_number,
    summary: toOrderSummary(o),
    chain: chainParts(group.members),
    feeCents,
    refundCents,
    orderUrl: `${appUrl}/cliente/ordini/${o.id}`,
  });
  await sendEmail(db, { ...rendered, templateCode: ORDER_CANCELLED_TEMPLATE, to: profile.email, recipientId: o.customer_id, orderId: o.id });
}

/** Request on an assigned job: the team decides (no customer data in the e-mail), the carrier stops. */
export async function sendCancellationRequestEmails(db: SupabaseClient, orderId: string, appUrl: string, adminEmail: string | null): Promise<void> {
  const { o, summary } = await loadOrder(db, orderId);
  const [{ data: carrier }, { data: person }] = o.carrier_id
    ? await Promise.all([
        db.from("carriers").select("company_name").eq("profile_id", o.carrier_id).single(),
        db.from("profiles").select("email, first_name").eq("id", o.carrier_id).single(),
      ])
    : [{ data: null }, { data: null }];

  const errors: string[] = [];
  if (adminEmail) {
    const rendered = renderCancellationRequestedEmail({ orderNumber: o.order_number, companyName: carrier?.company_name ?? null, summary, adminOrderUrl: `${appUrl}/admin/ordini/${o.id}` });
    await sendEmail(db, { ...rendered, templateCode: CANCELLATION_REQUESTED_TEMPLATE, to: adminEmail, orderId: o.id }).catch((e) => errors.push(`admin: ${e}`));
  } else {
    errors.push("ADMIN_NOTIFICATION_EMAIL not set");
  }
  if (o.carrier_id && person?.email) {
    const rendered = renderCarrierJobCancelledEmail({
      firstName: person.first_name, orderNumber: o.order_number, summary,
      jobUrl: `${appUrl}/padroncino/le-mie-corse/${o.id}`,
    });
    await sendEmail(db, { ...rendered, templateCode: CARRIER_JOB_CANCELLED_TEMPLATE, to: person.email, recipientId: o.carrier_id, orderId: o.id }).catch((e) => errors.push(`carrier: ${e}`));
  }
  if (errors.length) throw new Error(errors.join("; "));
}

/** D137 settings for the preview. settings is admin-only (RLS): read with the service role, numbers only. */
export async function loadCancellationSettings(db: SupabaseClient): Promise<{ freeHours: number; feeBp: number }> {
  const { data, error } = await db.from("settings").select("free_cancellation_hours, late_cancellation_fee_bp").single();
  if (error || !data) throw new Error(`settings: ${error?.message ?? "missing"}`);
  return { freeHours: data.free_cancellation_hours, feeBp: data.late_cancellation_fee_bp };
}
