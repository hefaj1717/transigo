import "server-only";
import type { AdminDeps } from "@/lib/admin/deps";
import { isVatTakenError } from "@/lib/auth/errors";
import { carrierCompanyRow, carrierCompanySchema, toFieldErrors, type FieldErrors } from "@/lib/auth/schemas";
import { sendEmail } from "@/lib/notifications/email";
import type { RenderedEmail } from "@/lib/notifications/templates/common";
import {
  CARRIER_APPROVED_TEMPLATE,
  CARRIER_DOCUMENT_REJECTED_TEMPLATE,
  CARRIER_REACTIVATED_TEMPLATE,
  CARRIER_REJECTED_TEMPLATE,
  CARRIER_SUSPENDED_TEMPLATE,
  renderCarrierApprovedEmail,
  renderCarrierDocumentRejectedEmail,
  renderCarrierReactivatedEmail,
  renderCarrierRejectedEmail,
  renderCarrierSuspendedEmail,
} from "@/lib/notifications/templates/carrier-decisions";
import { ADMIN_CARRIER_MSG, adminCarrierDbError, decisionSchema, idSchema, suspensionSchema } from "./admin";
import { documentTypeConfig, type CarrierDocumentType } from "./document-types";
import { CARRIER_PATHS } from "./onboarding";

// Admin operations on carriers (D101, D105, D113–D115). Called by the Server Actions in
// src/app/(admin)/admin/padroncini/actions.ts AFTER the admin check in the session; `admin.userId` always comes
// from that session, never from the form. The database functions are service-role only and check the admin
// again. Kept apart from the actions so tests/rls can run them against the local database.

export type { AdminDeps } from "@/lib/admin/deps";

export type AdminResult = { ok: true; message: string } | { ok: false; error: string };
export type CompanyResult = { ok: true; message: string; changed: string[] } | { ok: false; errors: FieldErrors };

const fail = (error: string): AdminResult => ({ ok: false, error });

type DbError = { code?: string | null; message?: string | null } | null;
const logDbError = (where: string, error: DbError) =>
  console.error(`[admin-carriers] ${where}:`, error?.code ?? "", error?.message ?? ""); // no personal data

/** audit_log entry for decide_carrier_review (the newer functions write their own in the same transaction). */
async function writeAudit(deps: AdminDeps, action: string, entityId: string, data: Record<string, unknown> = {}) {
  const { error } = await deps.serviceDb.from("audit_log").insert({
    actor_id: deps.admin.userId, actor_email: deps.admin.email, action, entity_type: "carrier", entity_id: entityId, data,
  });
  if (error) logDbError("audit", error);
}

/** Queues an e-mail to the carrier. A failure is logged, never undoes the decision. */
async function emailCarrier(deps: AdminDeps, carrierId: string, templateCode: string, render: (companyName: string) => RenderedEmail) {
  try {
    const [{ data: profile }, { data: carrier }] = await Promise.all([
      deps.serviceDb.from("profiles").select("email").eq("id", carrierId).single(),
      deps.serviceDb.from("carriers").select("company_name").eq("profile_id", carrierId).single(),
    ]);
    if (!profile?.email) throw new Error("carrier e-mail not found");
    await sendEmail(deps.serviceDb, { ...render(carrier?.company_name ?? "—"), templateCode, to: profile.email, recipientId: carrierId });
  } catch (e) {
    console.error(`[admin-carriers] ${templateCode} e-mail failed:`, e instanceof Error ? e.message : e, { carrierId });
  }
}

// ---------------------------------------------------------------------------
// Approva / Rifiuta a submission (D101)
// ---------------------------------------------------------------------------

export async function decideCarrier(deps: AdminDeps, input: Record<string, string>): Promise<AdminResult> {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return fail(input.decision === "reject" ? ADMIN_CARRIER_MSG.reasonRequired : ADMIN_CARRIER_MSG.generic);
  const d = parsed.data;
  const approve = d.decision === "approve";
  const reason = d.decision === "reject" ? d.reason : null;

  const { error } = await deps.serviceDb.rpc("decide_carrier_review", {
    p_carrier_id: d.id, p_admin_id: deps.admin.userId, p_approve: approve, p_reason: reason,
  });
  if (error) {
    if (error.code !== "23514" && error.code !== "55000") logDbError("decide_carrier_review", error);
    const { data: vehicles } = await deps.serviceDb.from("carrier_vehicles").select("id, plate").eq("carrier_id", d.id);
    return fail(adminCarrierDbError(error, "decide", vehicles ?? []));
  }

  // The reason is free text: it stays on the carrier, not in the log (D65).
  await writeAudit(deps, approve ? "carrier.approved" : "carrier.rejected", d.id);
  await emailCarrier(deps, d.id, approve ? CARRIER_APPROVED_TEMPLATE : CARRIER_REJECTED_TEMPLATE, (companyName) =>
    approve
      ? renderCarrierApprovedEmail({ companyName, appUrl: deps.appUrl })
      : renderCarrierRejectedEmail({ companyName, appUrl: deps.appUrl, reason: reason ?? "" }));
  return { ok: true, message: approve ? "Padroncino approvato." : "Registrazione rifiutata. Il padroncino riceverà un'e-mail con il motivo." };
}

// ---------------------------------------------------------------------------
// One document of an active / suspended carrier (D113)
// ---------------------------------------------------------------------------

export async function reviewDocument(deps: AdminDeps, input: Record<string, string>): Promise<AdminResult> {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return fail(input.decision === "reject" ? ADMIN_CARRIER_MSG.reasonRequired : ADMIN_CARRIER_MSG.generic);
  const d = parsed.data;
  const approve = d.decision === "approve";
  const reason = d.decision === "reject" ? d.reason : null;

  const { error } = await deps.serviceDb.rpc("review_carrier_document", {
    p_document_id: d.id, p_admin_id: deps.admin.userId, p_approve: approve, p_reason: reason,
  });
  if (error) {
    if (error.code !== "55000") logDbError("review_carrier_document", error);
    return fail(adminCarrierDbError(error, "document"));
  }

  if (!approve) {
    const { data: doc } = await deps.serviceDb
      .from("carrier_documents")
      .select("carrier_id, doc_type, vehicle_id, carrier_vehicles(plate)")
      .eq("id", d.id)
      .single<{ carrier_id: string; doc_type: CarrierDocumentType; vehicle_id: string | null; carrier_vehicles: { plate: string } | null }>();
    if (doc) {
      const path = doc.vehicle_id ? CARRIER_PATHS.vehicle(doc.vehicle_id) : CARRIER_PATHS.documents;
      await emailCarrier(deps, doc.carrier_id, CARRIER_DOCUMENT_REJECTED_TEMPLATE, (companyName) =>
        renderCarrierDocumentRejectedEmail({
          companyName,
          appUrl: deps.appUrl,
          documentLabel: documentTypeConfig(doc.doc_type).labelIt,
          plate: doc.carrier_vehicles?.plate ?? null,
          reason: reason ?? "",
          documentUrl: `${deps.appUrl}${path}#${doc.doc_type}`,
        }));
    }
  }
  return { ok: true, message: approve ? "Documento approvato." : "Documento rifiutato. Il padroncino riceverà un'e-mail con il motivo." };
}

// ---------------------------------------------------------------------------
// One vehicle of an active / suspended carrier (D114)
// ---------------------------------------------------------------------------

export async function approveVehicle(deps: AdminDeps, input: Record<string, string>): Promise<AdminResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return fail(ADMIN_CARRIER_MSG.notFound);
  const { error } = await deps.serviceDb.rpc("approve_carrier_vehicle", { p_vehicle_id: parsed.data.id, p_admin_id: deps.admin.userId });
  if (error) {
    if (error.code !== "23514" && error.code !== "55000") logDbError("approve_carrier_vehicle", error);
    const { data: vehicle } = await deps.serviceDb.from("carrier_vehicles").select("id, plate").eq("id", parsed.data.id).maybeSingle();
    return fail(adminCarrierDbError(error, "vehicle", vehicle ? [vehicle] : []));
  }
  return { ok: true, message: "Veicolo approvato insieme ai suoi documenti in attesa." };
}

// ---------------------------------------------------------------------------
// Sospendi / Riattiva (D115)
// ---------------------------------------------------------------------------

export async function setSuspension(deps: AdminDeps, input: Record<string, string>): Promise<AdminResult> {
  const parsed = suspensionSchema.safeParse(input);
  if (!parsed.success) return fail(input.decision === "suspend" ? ADMIN_CARRIER_MSG.reasonRequired : ADMIN_CARRIER_MSG.generic);
  const d = parsed.data;
  const suspend = d.decision === "suspend";
  const reason = d.decision === "suspend" ? d.reason : null;

  const { error } = await deps.serviceDb.rpc("set_carrier_suspension", {
    p_carrier_id: d.id, p_admin_id: deps.admin.userId, p_suspend: suspend, p_reason: reason,
  });
  if (error) {
    if (error.code !== "23514" && error.code !== "55000") logDbError("set_carrier_suspension", error);
    const { data: vehicles } = await deps.serviceDb.from("carrier_vehicles").select("id, plate").eq("carrier_id", d.id);
    return fail(adminCarrierDbError(error, suspend ? "suspend" : "reactivate", vehicles ?? []));
  }

  await emailCarrier(deps, d.id, suspend ? CARRIER_SUSPENDED_TEMPLATE : CARRIER_REACTIVATED_TEMPLATE, (companyName) =>
    suspend
      ? renderCarrierSuspendedEmail({ companyName, appUrl: deps.appUrl, reason: reason ?? "" })
      : renderCarrierReactivatedEmail({ companyName, appUrl: deps.appUrl }));
  return { ok: true, message: suspend ? "Padroncino sospeso." : "Padroncino riattivato." };
}

// ---------------------------------------------------------------------------
// Dati aziendali by the admin (D105)
// ---------------------------------------------------------------------------

export async function updateCarrierCompany(deps: AdminDeps, carrierId: string, input: Record<string, string>): Promise<CompanyResult> {
  if (!idSchema.safeParse({ id: carrierId }).success) return { ok: false, errors: { _form: ADMIN_CARRIER_MSG.notFound } };
  const parsed = carrierCompanySchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: toFieldErrors(parsed.error) };

  const { data, error } = await deps.serviceDb.rpc("admin_update_carrier_company", {
    p_carrier_id: carrierId, p_admin_id: deps.admin.userId, p_changes: carrierCompanyRow(parsed.data),
  });
  if (error) {
    if (isVatTakenError(error)) return { ok: false, errors: { vatNumber: ADMIN_CARRIER_MSG.vatTaken } };
    logDbError("admin_update_carrier_company", error);
    return { ok: false, errors: { _form: error.code === "42501" ? ADMIN_CARRIER_MSG.forbidden : ADMIN_CARRIER_MSG.generic } };
  }
  const changed = (data as string[] | null) ?? [];
  return { ok: true, changed, message: changed.length ? "Dati aziendali aggiornati." : "Nessuna modifica." };
}
