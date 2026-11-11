import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminDeps } from "@/lib/admin/deps";
import { getStripe } from "@/lib/stripe/server";
import { refundStatusFromStripe, type RefundStatus } from "./cancellation";
import { sendOrderCancelledEmail } from "./cancellation-server";
import {
  decideCancellationSchema,
  manualRefundSchema,
  REFUND_MSG,
  refundDbError,
  refundFormError,
  resolvePaymentReviewSchema,
  retryRefundSchema,
} from "./admin-refunds";

// Admin money decisions (D140–D142). Called by the Server Actions in src/app/(admin)/admin/ordini/actions.ts AFTER
// the admin check in the session (adminDeps); the admin id always comes from that session. Order of operations, as
// in the customer cancellation (D137):
//   1. the database function decides and writes the pending `refunds` row (amounts checked there, under the lock);
//   2. the Stripe Refund for that row — idempotency key refund:<id>, so "Riprova" never refunds twice;
//   3. record_refund_result() with Stripe's answer (later outcomes arrive through the webhook, refund.updated).
// A Stripe error never undoes the decision: the row stays pending and the page offers "Riprova".

export type RefundResult = { ok: true; message: string } | { ok: false; error: string };

export type StripeRefundRequest = { refundId: string; orderId: string; paymentIntentId: string; amountCents: number; reason?: "requested_by_customer" };

/** Stripe + recording, replaceable in tests. */
export type RefundIo = {
  createStripeRefund: (r: StripeRefundRequest) => Promise<{ id: string; status: string | null }>;
  recordRefund: (refundId: string, stripeRefundId: string | null, status: RefundStatus) => Promise<void>;
};

export function stripeRefundIo(db: SupabaseClient): RefundIo {
  return {
    createStripeRefund: ({ refundId, orderId, paymentIntentId, amountCents, reason }) =>
      getStripe().refunds.create(
        { payment_intent: paymentIntentId, amount: amountCents, ...(reason ? { reason } : {}), metadata: { refund_id: refundId, order_id: orderId } },
        { idempotencyKey: `refund:${refundId}` },
      ),
    recordRefund: async (refundId, stripeRefundId, status) => {
      const { error } = await db.rpc("record_refund_result", { p_refund_id: refundId, p_stripe_refund_id: stripeRefundId, p_status: status });
      if (error) throw new Error(`record_refund_result: ${error.message}`);
    },
  };
}

type DbError = { code?: string | null; message?: string | null; details?: string | null } | null;
const log = (where: string, data: Record<string, unknown>) => console.error(`[admin-refunds] ${where}`, data); // ids and codes only
const expected = (e: DbError) => e?.code === "55000" || e?.code === "22023";

/** Steps 2–3. Never throws: an error leaves the row pending ("Riprova"). */
export async function executeRefund(io: RefundIo, r: Omit<StripeRefundRequest, "paymentIntentId"> & { paymentIntentId: string | null }): Promise<RefundStatus> {
  try {
    if (!r.paymentIntentId) throw new Error("payment without payment_intent_id");
    const stripe = await io.createStripeRefund({ ...r, paymentIntentId: r.paymentIntentId });
    const status = refundStatusFromStripe(stripe.status);
    await io.recordRefund(r.refundId, stripe.id, status);
    return status;
  } catch (e) {
    log("refund not completed", { refundId: r.refundId, orderId: r.orderId, error: e instanceof Error ? e.message : String(e) });
    return "pending";
  }
}

const stripeNote = (s: RefundStatus) => (s === "pending" ? REFUND_MSG.stripePending : s === "failed" ? REFUND_MSG.stripeFailed : "");

// ---------------------------------------------------------------------------
// D140 — decision on a cancellation request
// ---------------------------------------------------------------------------
type DecideRow = { result: "cancelled" | "already_decided"; refund_id: string | null; refund_cents: number | null; payment_intent_id: string | null; order_number: string };

export async function decideCancellation(deps: AdminDeps, input: Record<string, string>, io: RefundIo = stripeRefundIo(deps.serviceDb)): Promise<RefundResult> {
  const parsed = decideCancellationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: refundFormError(parsed.error.issues) };
  const { orderId, refund, carrier } = parsed.data;
  const { data, error } = await deps.serviceDb
    .rpc("admin_decide_cancellation", { p_order_id: orderId, p_admin_id: deps.admin.userId, p_refund_cents: refund, p_carrier_cents: carrier })
    .single<DecideRow>();
  if (error || !data) {
    if (!expected(error)) log("admin_decide_cancellation", { orderId, code: error?.code });
    return { ok: false, error: refundDbError(error) };
  }
  if (data.result === "already_decided") return { ok: false, error: REFUND_MSG.alreadyDecided };

  let status: RefundStatus = "succeeded";
  if (data.refund_id && refund > 0) {
    status = await executeRefund(io, { refundId: data.refund_id, orderId, paymentIntentId: data.payment_intent_id, amountCents: refund, reason: "requested_by_customer" });
  }
  try {
    await sendOrderCancelledEmail(deps.serviceDb, orderId, deps.appUrl);
  } catch (e) {
    log("order_cancelled e-mail failed", { orderId, error: e instanceof Error ? e.message : String(e) });
  }
  return { ok: true, message: REFUND_MSG.decided(refund) + (refund > 0 ? stripeNote(status) : "") };
}

// ---------------------------------------------------------------------------
// D141 — payment_review
// ---------------------------------------------------------------------------
type ReviewRow = { result: "paid" | "refunded" | "already_resolved"; refund_id: string | null; refund_cents: number | null; payment_intent_id: string | null; order_id: string; order_number: string };

export async function resolvePaymentReview(deps: AdminDeps, input: Record<string, string>, io: RefundIo = stripeRefundIo(deps.serviceDb)): Promise<RefundResult> {
  const parsed = resolvePaymentReviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: REFUND_MSG.generic };
  const { paymentId, action } = parsed.data;
  const { data, error } = await deps.serviceDb
    .rpc("admin_resolve_payment_review", { p_payment_id: paymentId, p_admin_id: deps.admin.userId, p_action: action })
    .single<ReviewRow>();
  if (error || !data) {
    if (!expected(error)) log("admin_resolve_payment_review", { paymentId, code: error?.code });
    return { ok: false, error: refundDbError(error) };
  }
  if (data.result === "already_resolved") return { ok: false, error: REFUND_MSG.alreadyResolved };
  if (data.result === "paid") return { ok: true, message: REFUND_MSG.markedPaid };

  let status: RefundStatus = "succeeded";
  if (data.refund_id && data.refund_cents) {
    status = await executeRefund(io, { refundId: data.refund_id, orderId: data.order_id, paymentIntentId: data.payment_intent_id, amountCents: data.refund_cents });
  }
  return { ok: true, message: REFUND_MSG.reviewRefunded + stripeNote(status) };
}

// ---------------------------------------------------------------------------
// D142 — manual refund and retry
// ---------------------------------------------------------------------------
type ManualRow = { refund_id: string; full_refund: boolean; new_status: string; payment_intent_id: string | null; order_number: string };

export async function refundOrder(deps: AdminDeps, input: Record<string, string>, io: RefundIo = stripeRefundIo(deps.serviceDb)): Promise<RefundResult> {
  const parsed = manualRefundSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: refundFormError(parsed.error.issues) };
  const { orderId, amount, reason } = parsed.data;
  const { data, error } = await deps.serviceDb
    .rpc("admin_refund_order", { p_order_id: orderId, p_admin_id: deps.admin.userId, p_amount_cents: amount, p_reason_code: reason })
    .single<ManualRow>();
  if (error || !data) {
    if (!expected(error)) log("admin_refund_order", { orderId, code: error?.code });
    return { ok: false, error: refundDbError(error) };
  }
  const status = await executeRefund(io, { refundId: data.refund_id, orderId, paymentIntentId: data.payment_intent_id, amountCents: amount });
  return { ok: true, message: REFUND_MSG.refunded(data.full_refund) + stripeNote(status) };
}

type RetryRow = { refund_id: string; amount_cents: number; payment_intent_id: string | null; order_id: string; newly_created: boolean };

export async function retryRefund(deps: AdminDeps, input: Record<string, string>, io: RefundIo = stripeRefundIo(deps.serviceDb)): Promise<RefundResult> {
  const parsed = retryRefundSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: REFUND_MSG.generic };
  const { data, error } = await deps.serviceDb
    .rpc("admin_retry_refund", { p_refund_id: parsed.data.refundId, p_admin_id: deps.admin.userId })
    .single<RetryRow>();
  if (error || !data) {
    if (!expected(error)) log("admin_retry_refund", { refundId: parsed.data.refundId, code: error?.code });
    return { ok: false, error: refundDbError(error) };
  }
  // Same row (pending) → same idempotency key: Stripe returns the refund it already made, if any.
  const status = await executeRefund(io, { refundId: data.refund_id, orderId: data.order_id, paymentIntentId: data.payment_intent_id, amountCents: data.amount_cents });
  return { ok: true, message: REFUND_MSG.retried + stripeNote(status) };
}
