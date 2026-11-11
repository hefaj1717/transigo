import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { creditNoteAfterRefund } from "@/lib/einvoice/server";
import type { RefundStatus } from "./cancellation";

/**
 * record_refund_result() + the credit note of a succeeded refund (D146). The one place every refund outcome goes
 * through (customer cancellation, admin decisions, Stripe webhook). Returns whether the row changed. A credit note
 * problem is logged and never fails the refund (the cron catches up).
 */
export async function recordRefundResult(db: SupabaseClient, refundId: string, stripeRefundId: string | null, status: RefundStatus): Promise<boolean> {
  const { data, error } = await db.rpc("record_refund_result", { p_refund_id: refundId, p_stripe_refund_id: stripeRefundId, p_status: status });
  if (error) throw new Error(`record_refund_result: ${error.message}`);
  await creditNoteAfterRefund(db, refundId, status);
  return data as boolean;
}
