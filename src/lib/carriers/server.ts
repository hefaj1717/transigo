import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CarrierStatus } from "@/lib/auth/routing";
import { AUTH_MSG, isVatTakenError } from "@/lib/auth/errors";
import { carrierCompanyRow, carrierCompanySchema, toFieldErrors, type FieldErrors } from "@/lib/auth/schemas";
import { sendEmail } from "@/lib/notifications/email";
import { CARRIER_SUBMITTED_TEMPLATE, renderCarrierSubmittedEmail } from "@/lib/notifications/templates/carrier-submitted";
import {
  canEditOnboarding,
  carrierOnboardingView,
  documentEditBlock,
  incompleteCodes,
  onboardingEditBlock,
  ONBOARDING_MSG,
  vehicleEditBlock,
  type CarrierOnboardingView,
} from "./onboarding";
import { vehicleDbError, vehicleRow, vehicleSchema, VEHICLE_MSG } from "./vehicles";
import {
  checkDocumentExpiry,
  DOCUMENT_MSG,
  documentUploadSchema,
  EXT_BY_MIME,
  MAX_DOCUMENT_BYTES,
  parseDocumentStoragePath,
  romeToday,
  type DocumentMime,
} from "./documents";

export const CARRIER_DOCUMENTS_BUCKET = "carrier-documents";

// Carrier onboarding operations (Stage 4.1). Called by Server Actions with the carrier's OWN session client
// (RLS, column grants and triggers apply — never the service role) and the user id from the verified session.
// Kept apart from the actions so tests/rls can run them against the local database.

export type CarrierResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; errors: FieldErrors; offerNewVehicle?: boolean };

const fail = (message: string, field = "_form"): CarrierResult<never> => ({ ok: false, errors: { [field]: message } });

type DbError = { code?: string | null; message?: string | null } | null;
const logDbError = (where: string, error: DbError) =>
  console.error(`[carriers] ${where}:`, error?.code ?? "", error?.message ?? ""); // no personal data

export async function loadCarrierView(db: SupabaseClient, userId: string): Promise<CarrierOnboardingView> {
  const { data, error } = await db.from("carriers").select("status, submitted_at").eq("profile_id", userId).maybeSingle();
  if (error) {
    logDbError("loadCarrierView", error);
    throw new Error("carrier state unavailable");
  }
  return carrierOnboardingView((data?.status as CarrierStatus | undefined) ?? null, data?.submitted_at ?? null);
}

// ---------------------------------------------------------------------------
// Dati aziendali (D45, D105)
// ---------------------------------------------------------------------------

export async function saveCarrierCompany(db: SupabaseClient, userId: string, input: Record<string, string>): Promise<CarrierResult> {
  const view = await loadCarrierView(db, userId);
  if (!canEditOnboarding(view)) return fail(view === "in_review" ? ONBOARDING_MSG.inReview : ONBOARDING_MSG.companyLocked);

  const parsed = carrierCompanySchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: toFieldErrors(parsed.error) };

  const { data, error } = await db
    .from("carriers")
    .update(carrierCompanyRow(parsed.data))
    .eq("profile_id", userId)
    .select("profile_id");
  if (error) {
    if (isVatTakenError(error)) return fail(AUTH_MSG.vatTaken, "vatNumber");
    if (error.code === "42501") return fail(ONBOARDING_MSG.companyLocked); // D105 lock (sent for review meanwhile)
    logDbError("saveCarrierCompany", error);
    return fail(ONBOARDING_MSG.generic);
  }
  if (!data?.length) return fail(ONBOARDING_MSG.generic);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Veicoli (D102, D107, D111, D112)
// ---------------------------------------------------------------------------

async function vehicleTypeSelectable(db: SupabaseClient, typeId: string, currentTypeId?: string): Promise<boolean> {
  if (typeId === currentTypeId) return true; // keeps a type the admin deactivated later
  const { data } = await db.from("vehicle_types").select("id").eq("id", typeId).eq("is_active", true).maybeSingle();
  return !!data;
}

function vehicleWriteError(where: string, error: DbError): CarrierResult<never> {
  const known = vehicleDbError(error);
  if (known) return { ok: false, errors: { [known.field]: known.message }, offerNewVehicle: known.offerNewVehicle };
  logDbError(where, error);
  return fail(ONBOARDING_MSG.generic);
}

export async function createCarrierVehicle(db: SupabaseClient, userId: string, input: Record<string, string>): Promise<CarrierResult<{ id: string }>> {
  const block = vehicleEditBlock(await loadCarrierView(db, userId));
  if (block) return fail(block);

  const parsed = vehicleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: toFieldErrors(parsed.error) };
  if (!(await vehicleTypeSelectable(db, parsed.data.vehicleTypeId))) return fail(VEHICLE_MSG.vehicleType, "vehicleTypeId");

  const { data, error } = await db
    .from("carrier_vehicles")
    .insert({ carrier_id: userId, ...vehicleRow(parsed.data) })
    .select("id")
    .single();
  if (error || !data) return vehicleWriteError("createCarrierVehicle", error);
  return { ok: true, data: { id: data.id as string } };
}

const VEHICLE_NOT_FOUND = "Veicolo non trovato.";

export async function updateCarrierVehicle(
  db: SupabaseClient,
  userId: string,
  vehicleId: string,
  input: Record<string, string>,
): Promise<CarrierResult> {
  const block = vehicleEditBlock(await loadCarrierView(db, userId));
  if (block) return fail(block);

  // RLS returns only the carrier's own vehicle.
  const { data: current } = await db
    .from("carrier_vehicles")
    .select("id, vehicle_type_id, plate, first_approved_at")
    .eq("id", vehicleId)
    .eq("carrier_id", userId)
    .maybeSingle();
  if (!current) return fail(VEHICLE_NOT_FOUND);

  const parsed = vehicleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: toFieldErrors(parsed.error) };
  if (!(await vehicleTypeSelectable(db, parsed.data.vehicleTypeId, current.vehicle_type_id))) {
    return fail(VEHICLE_MSG.vehicleType, "vehicleTypeId");
  }
  // D107: checked here for a clear message; the trigger enforces it for every role anyway.
  if (current.first_approved_at && parsed.data.plate !== current.plate) {
    return { ok: false, errors: { plate: VEHICLE_MSG.plateLocked }, offerNewVehicle: true };
  }

  const { data, error } = await db
    .from("carrier_vehicles")
    .update(vehicleRow(parsed.data))
    .eq("id", vehicleId)
    .eq("carrier_id", userId)
    .select("id");
  if (error) return vehicleWriteError("updateCarrierVehicle", error);
  if (!data?.length) return fail(VEHICLE_NOT_FOUND);
  return { ok: true, data: undefined };
}

/** Deactivate / reactivate (no delete). Does not change the approval (D107). */
export async function setCarrierVehicleActive(db: SupabaseClient, userId: string, vehicleId: string, active: boolean): Promise<CarrierResult> {
  const block = vehicleEditBlock(await loadCarrierView(db, userId));
  if (block) return fail(block);

  const { data, error } = await db
    .from("carrier_vehicles")
    .update({ is_active: active })
    .eq("id", vehicleId)
    .eq("carrier_id", userId)
    .select("id");
  if (error) {
    logDbError("setCarrierVehicleActive", error);
    return fail(ONBOARDING_MSG.generic);
  }
  if (!data?.length) return fail(VEHICLE_NOT_FOUND);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Documenti (D98, D103, D112)
// ---------------------------------------------------------------------------

/**
 * Records a file the browser has just uploaded to Storage (own folder, storage policy) as a carrier_documents row.
 * Size and type come from the Storage metadata, never from the form; the row is written with the carrier's
 * session (RLS insert policy + validate_carrier_document trigger). A file without a row is cleaned up later (D103).
 */
export async function registerCarrierDocument(
  db: SupabaseClient,
  userId: string,
  input: Record<string, string>,
  now: Date = new Date(),
): Promise<CarrierResult<{ id: string }>> {
  const block = documentEditBlock(await loadCarrierView(db, userId)); // D112: also when suspended
  if (block) return fail(block);

  const parsed = documentUploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: toFieldErrors(parsed.error) };
  const d = parsed.data;

  const path = parseDocumentStoragePath(d.storagePath, userId);
  if (!path) return fail(DOCUMENT_MSG.fileMissing);

  const expiry = checkDocumentExpiry(d.docType, d.expiresAt, romeToday(now));
  if (!expiry.ok) return fail(expiry.error, "expiresAt");

  if (d.vehicleId) {
    const { data: vehicle } = await db
      .from("carrier_vehicles")
      .select("id")
      .eq("id", d.vehicleId)
      .eq("carrier_id", userId)
      .eq("is_active", true)
      .maybeSingle();
    if (!vehicle) return fail("Veicolo non trovato o disattivato.", "vehicleId");
  }

  // Storage metadata with the carrier's session (select policy: own folder only).
  const { data: info, error: infoError } = await db.storage.from(CARRIER_DOCUMENTS_BUCKET).info(d.storagePath);
  if (infoError || !info) return fail(DOCUMENT_MSG.fileMissing);
  const meta = info as { size?: number; contentType?: string; content_type?: string };
  const size = Number(meta.size ?? 0);
  const mime = String(meta.contentType ?? meta.content_type ?? "").toLowerCase();
  if (!(mime in EXT_BY_MIME) || EXT_BY_MIME[mime as DocumentMime] !== path.ext) return fail(DOCUMENT_MSG.type);
  if (size <= 0) return fail(DOCUMENT_MSG.empty);
  if (size > MAX_DOCUMENT_BYTES) return fail(DOCUMENT_MSG.tooLarge);

  const { data, error } = await db
    .from("carrier_documents")
    .insert({
      carrier_id: userId,
      vehicle_id: d.vehicleId ?? null,
      doc_type: d.docType,
      storage_path: d.storagePath,
      expires_at: expiry.expiresAt,
      file_name: d.fileName,
      mime_type: mime,
      size_bytes: size,
    })
    .select("id")
    .single();
  if (error || !data) {
    if (error?.code === "23505") return fail("Questo file è già stato registrato.");
    logDbError("registerCarrierDocument", error);
    return fail(ONBOARDING_MSG.generic);
  }
  return { ok: true, data: { id: data.id as string } };
}

// ---------------------------------------------------------------------------
// Invia per la verifica (D100, D106, D110)
// ---------------------------------------------------------------------------

export type SubmitResult =
  | { ok: true; submittedAt: string; newlySubmitted: boolean }
  | { ok: false; error: string; missing?: string[] };

export type SubmitDeps = {
  /** Service-role client: email_outbox is written only by the server. */
  serviceDb: SupabaseClient;
  /** ADMIN_NOTIFICATION_EMAIL; null = not configured (the submission still succeeds, the error is logged). */
  adminEmail: string | null;
  appUrl: string;
};

/**
 * Sends the account for review with the carrier's session. The e-mail to the Transigo team goes out only when
 * this call set submitted_at (newly_submitted, decided under the row lock — D106); the server does not check
 * the state beforehand. An e-mail failure does not undo the submission.
 */
export async function submitCarrierForReview(db: SupabaseClient, userId: string, deps: SubmitDeps): Promise<SubmitResult> {
  const { data, error } = await db
    .rpc("submit_carrier_for_review")
    .single<{ submitted_at: string; newly_submitted: boolean }>();
  if (error || !data) {
    const missing = incompleteCodes(error);
    if (missing) return { ok: false, error: ONBOARDING_MSG.incomplete, missing };
    if (error?.code === "55000") {
      const block = onboardingEditBlock(await loadCarrierView(db, userId));
      return { ok: false, error: block ?? ONBOARDING_MSG.notEditable };
    }
    logDbError("submitCarrierForReview", error);
    return { ok: false, error: ONBOARDING_MSG.generic };
  }

  if (data.newly_submitted) {
    try {
      await notifyAdminOfSubmission(db, userId, data.submitted_at, deps);
    } catch (e) {
      console.error("[carriers] carrier_submitted e-mail failed:", e instanceof Error ? e.message : e);
    }
  }
  return { ok: true, submittedAt: data.submitted_at, newlySubmitted: data.newly_submitted };
}

async function notifyAdminOfSubmission(db: SupabaseClient, userId: string, submittedAt: string, deps: SubmitDeps): Promise<void> {
  if (!deps.adminEmail) {
    console.error("[carriers] ADMIN_NOTIFICATION_EMAIL not set — carrier_submitted e-mail not queued", { carrierId: userId });
    return;
  }
  const { data: carrier } = await db.from("carriers").select("company_name, decided_at").eq("profile_id", userId).single();
  const rendered = renderCarrierSubmittedEmail({
    companyName: carrier?.company_name ?? "—",
    carrierId: userId,
    submittedAt: new Date(submittedAt),
    // An account sent again after a rejection keeps decided_at of that decision (D101).
    resubmission: !!carrier?.decided_at,
    adminUrl: `${deps.appUrl}/admin/padroncini`,
  });
  await sendEmail(deps.serviceDb, { ...rendered, templateCode: CARRIER_SUBMITTED_TEMPLATE, to: deps.adminEmail });
}
