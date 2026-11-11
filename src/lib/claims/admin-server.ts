import "server-only";
import type { AdminDeps } from "@/lib/admin/deps";
import { sendEmail } from "@/lib/notifications/email";
import { CLAIM_CLOSED_TEMPLATE, renderClaimClosedEmail } from "@/lib/notifications/templates/claim-closed";
import { CLAIM_ADMIN_MSG, closeClaimSchema } from "./admin";
import type { ClaimCategory } from "./claims";

// "Chiudi con nota" (D138). Called by src/app/(admin)/admin/reclami/actions.ts AFTER the admin check in the session
// (adminDeps); the admin id is the session's. admin_close_claim (service role) checks the admin again and writes the
// audit in the same transaction (ids only — the note is free text). The customer e-mail goes after a real change;
// its failure is logged and never undoes the closing.

export type CloseClaimResult = { ok: true; message: string } | { ok: false; error: string };

export async function closeClaim(deps: AdminDeps, input: Record<string, string>): Promise<CloseClaimResult> {
  const parsed = closeClaimSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.some((i) => i.path[0] === "note") ? CLAIM_ADMIN_MSG.noteRequired : CLAIM_ADMIN_MSG.notFound };
  }
  const { claimId, note } = parsed.data;
  const { data: changed, error } = await deps.serviceDb.rpc("admin_close_claim", { p_claim_id: claimId, p_admin_id: deps.admin.userId, p_note: note });
  if (error) {
    if (error.details === "claim") return { ok: false, error: CLAIM_ADMIN_MSG.notFound };
    if (error.details === "note") return { ok: false, error: CLAIM_ADMIN_MSG.noteRequired };
    console.error("[admin-claims] admin_close_claim:", error.code, error.message);
    return { ok: false, error: CLAIM_ADMIN_MSG.generic };
  }
  if (changed !== true) return { ok: false, error: CLAIM_ADMIN_MSG.alreadyClosed };

  try {
    await sendClaimClosedEmail(deps, claimId);
  } catch (e) {
    console.error("[admin-claims] claim_closed e-mail failed", { claimId, error: e instanceof Error ? e.message : String(e) });
  }
  return { ok: true, message: CLAIM_ADMIN_MSG.closed };
}

async function sendClaimClosedEmail(deps: AdminDeps, claimId: string): Promise<void> {
  const db = deps.serviceDb;
  const { data: c, error } = await db
    .from("claims")
    .select("id, order_id, customer_id, category, resolution_note, orders(order_number)")
    .eq("id", claimId)
    .single<{ id: string; order_id: string; customer_id: string; category: ClaimCategory; resolution_note: string; orders: { order_number: string } | null }>();
  if (error || !c) throw new Error(`claim: ${error?.message ?? "not found"}`);
  const { data: profile } = await db.from("profiles").select("email, first_name").eq("id", c.customer_id).single();
  if (!profile?.email) throw new Error("customer e-mail not found");
  const rendered = renderClaimClosedEmail({
    firstName: profile.first_name,
    orderNumber: c.orders?.order_number ?? "",
    category: c.category,
    note: c.resolution_note,
    claimsUrl: `${deps.appUrl}/cliente/reclami`,
  });
  await sendEmail(db, { ...rendered, templateCode: CLAIM_CLOSED_TEMPLATE, to: profile.email, recipientId: c.customer_id, orderId: c.order_id, eventKey: `claim:${c.id}` });
}
