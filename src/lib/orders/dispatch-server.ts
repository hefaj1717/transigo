import "server-only";
import type { AdminDeps } from "@/lib/admin/deps";
import { sendOrderAssignedEmail, sendOrderDeliveredEmail } from "./customer-emails";
import { ORDER_STATUS_LABEL } from "./status";
import { advanceSchema, assignSchema, DISPATCH_MSG, dispatchDbError, handoverSchema, unassignSchema } from "./dispatch";
import { earlyStartSchema, EXEC_ADMIN_MSG, execAdminDbError, formError, revertSchema, stepTitle } from "./execution-view";

// Admin dispatch (D122, D123). Called by the Server Actions in src/app/(admin)/admin/ordini/actions.ts AFTER the
// admin check in the session (adminDeps); `admin.userId` always comes from that session, never from the form.
// The database functions are service-role only and check the admin again. Kept apart from the actions so
// tests/rls can run them against the local database.

export type DispatchResult = { ok: true; message: string } | { ok: false; error: string };

type DbError = { code?: string | null; message?: string | null; details?: string | null } | null;
const log = (where: string, error: DbError) => console.error(`[dispatch] ${where}:`, error?.code ?? "", error?.message ?? ""); // ids only
const expected = (e: DbError) => e?.code === "55000" || e?.code === "22023";

/** Customer e-mail after a successful change; a failure is logged and never undoes the change. */
async function notifyCustomer(where: string, send: () => Promise<void>) {
  try {
    await send();
  } catch (e) {
    console.error(`[dispatch] ${where} e-mail failed:`, e instanceof Error ? e.message : e);
  }
}

export type Candidate = { carrier_id: string; company_name: string; vehicle_id: string; plate: string; vehicle_type_name: string; payload_kg: number | null };

/** Carriers + vehicles that may take the order now (same rules as accept_job, D120). */
export async function loadCandidates(deps: AdminDeps, orderId: string): Promise<Candidate[]> {
  const { data, error } = await deps.serviceDb.rpc("admin_job_candidates", { p_order_id: orderId, p_admin_id: deps.admin.userId });
  if (error) {
    log("admin_job_candidates", error);
    throw new Error("candidates unavailable");
  }
  return (data ?? []) as Candidate[];
}

export async function assignJob(deps: AdminDeps, input: Record<string, string>): Promise<DispatchResult> {
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: DISPATCH_MSG.chooseCandidate };
  const { orderId, candidate } = parsed.data;
  const { error } = await deps.serviceDb.rpc("admin_assign_job", {
    p_order_id: orderId, p_carrier_id: candidate.carrierId, p_vehicle_id: candidate.vehicleId, p_admin_id: deps.admin.userId,
  });
  if (error) {
    if (!expected(error)) log("admin_assign_job", error);
    return { ok: false, error: dispatchDbError(error) };
  }
  await notifyCustomer("order_assigned", () => sendOrderAssignedEmail(deps.serviceDb, orderId, deps.appUrl));
  return { ok: true, message: DISPATCH_MSG.assigned };
}

/** "Da gestire": assign a carrier directly with the current address of the goods and an internal reason. */
export async function assignHandover(deps: AdminDeps, input: Record<string, string>): Promise<DispatchResult> {
  const parsed = handoverSchema.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return {
      ok: false,
      error: field === "address" ? DISPATCH_MSG.addressRequired : field === "reason" ? DISPATCH_MSG.handoverReasonRequired : DISPATCH_MSG.chooseCandidate,
    };
  }
  const { orderId, candidate, address, reason } = parsed.data;
  const { error } = await deps.serviceDb.rpc("admin_assign_handover", {
    p_order_id: orderId, p_carrier_id: candidate.carrierId, p_vehicle_id: candidate.vehicleId, p_admin_id: deps.admin.userId,
    p_address: address, p_reason: reason,
  });
  if (error) {
    if (!expected(error)) log("admin_assign_handover", error);
    return { ok: false, error: dispatchDbError(error) };
  }
  await notifyCustomer("order_assigned", () => sendOrderAssignedEmail(deps.serviceDb, orderId, deps.appUrl));
  return { ok: true, message: DISPATCH_MSG.handoverAssigned };
}

export async function unassignJob(deps: AdminDeps, input: Record<string, string>): Promise<DispatchResult> {
  const parsed = unassignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: DISPATCH_MSG.chooseReason };
  const { error } = await deps.serviceDb.rpc("admin_unassign_job", {
    p_order_id: parsed.data.orderId, p_admin_id: deps.admin.userId, p_reason_code: parsed.data.reason,
  });
  if (error) {
    if (!expected(error)) log("admin_unassign_job", error);
    return { ok: false, error: dispatchDbError(error) };
  }
  // load on board / goods in the warehouse → "da gestire" (D130, D136): the status stayed, the flag is set
  const { data: after } = await deps.serviceDb.from("orders").select("handover_required_at").eq("id", parsed.data.orderId).maybeSingle<{ handover_required_at: string | null }>();
  return { ok: true, message: after?.handover_required_at ? DISPATCH_MSG.unassignedHandover : DISPATCH_MSG.unassigned };
}

export async function advanceOrder(deps: AdminDeps, input: Record<string, string>): Promise<DispatchResult> {
  const parsed = advanceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.some((i) => i.path[0] === "note") ? DISPATCH_MSG.noteRequired : DISPATCH_MSG.generic };
  }
  const { error } = await deps.serviceDb.rpc("admin_advance_order", {
    p_order_id: parsed.data.orderId, p_admin_id: deps.admin.userId, p_to_status: parsed.data.to, p_note: parsed.data.note ?? null,
  });
  if (error) {
    if (!expected(error)) log("admin_advance_order", error);
    return { ok: false, error: dispatchDbError(error) };
  }
  if (parsed.data.to === "delivered") {
    await notifyCustomer("order_delivered", () => sendOrderDeliveredEmail(deps.serviceDb, parsed.data.orderId, deps.appUrl));
  }
  const label = ORDER_STATUS_LABEL[parsed.data.to] ?? parsed.data.to;
  return {
    ok: true,
    message: parsed.data.to === "delivered" ? `${DISPATCH_MSG.advanced(label)} ${DISPATCH_MSG.deliveredWithoutPod}` : DISPATCH_MSG.advanced(label),
  };
}

/**
 * "Annulla ultimo passo": the form carries the step the admin SAW. When the carrier recorded another step since,
 * nothing is undone (the admin reloads and decides again). The reason goes only to order_admin_notes.
 */
export async function revertLastStep(deps: AdminDeps, input: Record<string, string>): Promise<DispatchResult> {
  const parsed = revertSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: formError(parsed.error.issues) };
  const { orderId, leg, step, reason } = parsed.data;

  // The step the admin SAW goes to the database, which compares it with the last step under the order's row lock
  // (D136): another step in the meantime → 'changed' ("Ricarica la pagina"), nothing reverted.
  const { data, error } = await deps.serviceDb
    .rpc("admin_revert_last_step", { p_order_id: orderId, p_admin_id: deps.admin.userId, p_leg_index: leg, p_step: step, p_reason: reason })
    .single<{ leg_index: number; step: string; order_status: string }>();
  if (error) {
    if (!expected(error)) log("admin_revert_last_step", error);
    return { ok: false, error: execAdminDbError(error) };
  }
  const { count } = await deps.serviceDb.from("order_legs").select("leg_index", { count: "exact", head: true }).eq("order_id", orderId);
  return { ok: true, message: EXEC_ADMIN_MSG.reverted(stepTitle(data.leg_index, data.step as typeof step, count ?? 1)) };
}

/** "Consenti inizio anticipato" for one leg (reason → order_admin_notes only). */
export async function allowEarlyStart(deps: AdminDeps, input: Record<string, string>): Promise<DispatchResult> {
  const parsed = earlyStartSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: formError(parsed.error.issues) };
  const { data, error } = await deps.serviceDb
    .rpc("admin_allow_early_start", { p_order_id: parsed.data.orderId, p_leg_index: parsed.data.leg, p_admin_id: deps.admin.userId, p_reason: parsed.data.reason })
    .single<{ allowed_at: string; newly_allowed: boolean }>();
  if (error) {
    if (!expected(error)) log("admin_allow_early_start", error);
    return { ok: false, error: execAdminDbError(error) };
  }
  return { ok: true, message: data.newly_allowed ? EXEC_ADMIN_MSG.earlyStartAllowed : EXEC_ADMIN_MSG.earlyStartAlready };
}
