import "server-only";
import type { AdminDeps } from "@/lib/admin/deps";
import { blockSchema, CUSTOMER_ADMIN_MSG } from "./admin";

// Blocca / Sblocca cliente (D143). Called by src/app/(admin)/admin/clienti/actions.ts AFTER the admin check in the
// session (adminDeps); the admin id is the session's. admin_set_customer_blocked (service role) checks the admin
// again and writes the audit in the same transaction.

export type BlockResult = { ok: true; message: string } | { ok: false; error: string };

export async function setCustomerBlocked(deps: AdminDeps, input: Record<string, string>): Promise<BlockResult> {
  const parsed = blockSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: input.block === "1" ? CUSTOMER_ADMIN_MSG.chooseReason : CUSTOMER_ADMIN_MSG.notFound };
  }
  const block = parsed.data.block === "1";
  const { data, error } = await deps.serviceDb
    .rpc("admin_set_customer_blocked", {
      p_customer_id: parsed.data.customerId,
      p_admin_id: deps.admin.userId,
      p_block: block,
      p_reason_code: parsed.data.block === "1" ? parsed.data.reason : null,
    })
    .single<{ changed: boolean; active_orders: number }>();
  if (error || !data) {
    if (error?.details === "customer") return { ok: false, error: CUSTOMER_ADMIN_MSG.notFound };
    if (error?.details === "reason") return { ok: false, error: CUSTOMER_ADMIN_MSG.chooseReason };
    console.error("[admin-customers] admin_set_customer_blocked:", error?.code, error?.message);
    return { ok: false, error: CUSTOMER_ADMIN_MSG.generic };
  }
  if (!data.changed) return { ok: false, error: CUSTOMER_ADMIN_MSG.unchanged };
  return { ok: true, message: block ? CUSTOMER_ADMIN_MSG.blocked(data.active_orders) : CUSTOMER_ADMIN_MSG.unblocked };
}
