import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { sendEmail, type Defer } from "@/lib/notifications/email";
import { CLAIM_OPENED_TEMPLATE, renderClaimOpenedEmail } from "@/lib/notifications/templates/claim-opened";
import { CLAIM_MSG, claimErrorMessage, claimPhotoPath, isClaimPhotoPath, openClaimSchema, type ClaimCategory } from "./claims";

// Server side of the customer claims (D138). Every database call runs with the CUSTOMER's session (`db`): RLS,
// the bucket policy and the functions check ownership; the service role is used only AFTER a successful
// open_claim, for the team e-mail (the customer cannot read email_outbox / settings).

export type OpenClaimResult = { ok: true; claimId: string; newlyOpened: boolean } | { ok: false; message: string; errors?: Record<string, string> };

export type OpenClaimDeps = { service: () => SupabaseClient; appUrl: string; adminEmail: string | null; defer: Defer };

export async function openClaim(db: SupabaseClient, deps: OpenClaimDeps, input: unknown): Promise<OpenClaimResult> {
  const parsed = openClaimSchema.safeParse(input);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const i of parsed.error.issues) errors[String(i.path[0] ?? "_form")] ??= i.message;
    return { ok: false, message: errors.orderId ? CLAIM_MSG.notFound : "Controlla i campi evidenziati.", errors };
  }
  const { orderId, category, description } = parsed.data;
  const { data, error } = await db
    .rpc("open_claim", { p_order_id: orderId, p_category: category, p_description: description })
    .single<{ claim_id: string; newly_opened: boolean }>();
  if (error || !data) {
    if (!error?.details) console.error("[claims] open_claim:", error?.code, error?.message);
    return { ok: false, message: claimErrorMessage(error) };
  }
  if (data.newly_opened) notifyTeam(deps, orderId, data.claim_id, category);
  return { ok: true, claimId: data.claim_id, newlyOpened: data.newly_opened };
}

function notifyTeam(deps: OpenClaimDeps, orderId: string, claimId: string, category: ClaimCategory) {
  deps.defer(async () => {
    try {
      if (!deps.adminEmail) throw new Error("ADMIN_NOTIFICATION_EMAIL not set");
      const db = deps.service();
      const { data: o, error } = await db.from("orders").select("order_number").eq("id", orderId).single();
      if (error || !o) throw new Error(`order: ${error?.message ?? "not found"}`);
      const rendered = renderClaimOpenedEmail({ orderNumber: o.order_number, category, adminUrl: `${deps.appUrl}/admin/ordini/${orderId}` });
      await sendEmail(db, { ...rendered, templateCode: CLAIM_OPENED_TEMPLATE, to: deps.adminEmail, orderId, eventKey: `claim:${claimId}` });
    } catch (e) {
      console.error("[claims] claim_opened e-mail not queued", { claimId, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

export type PhotoTicket =
  | { ok: true; path: string; signedUrl: string | null; alreadyUploaded: boolean }
  | { ok: false; message: string };

const ticketInput = z.object({ claimId: z.uuid(), path: z.string().optional() });

/** A signed upload URL for one photo, created with the customer's session (the bucket policy checks the claim). */
export async function createClaimPhotoUpload(db: SupabaseClient, input: unknown): Promise<PhotoTicket> {
  const parsed = ticketInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: CLAIM_MSG.notFound };
  const { claimId, path: retryPath } = parsed.data;
  if (retryPath !== undefined && !isClaimPhotoPath(claimId, retryPath)) return { ok: false, message: CLAIM_MSG.photoInvalid };
  const path = retryPath ?? claimPhotoPath(claimId, randomUUID());
  const { data, error } = await db.storage.from("claim-photos").createSignedUploadUrl(path);
  if (!error && data) return { ok: true, path: data.path, signedUrl: data.signedUrl, alreadyUploaded: false };
  const e = error as { statusCode?: string | number; message?: string } | null;
  // "Riprova" after an upload that did arrive: register it.
  if (retryPath !== undefined && (String(e?.statusCode) === "409" || /already exists|duplicate/i.test(e?.message ?? ""))) {
    return { ok: true, path, signedUrl: null, alreadyUploaded: true };
  }
  if (String(e?.statusCode) === "403") return { ok: false, message: CLAIM_MSG.closed };
  console.error("[claims] signed upload URL:", e?.statusCode ?? "", e?.message ?? "");
  return { ok: false, message: CLAIM_MSG.generic };
}

const registerInput = z.object({ claimId: z.uuid(), path: z.string() });

export async function registerClaimPhoto(db: SupabaseClient, input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = registerInput.safeParse(input);
  if (!parsed.success || !isClaimPhotoPath(parsed.data.claimId, parsed.data.path)) return { ok: false, message: CLAIM_MSG.photoInvalid };
  const { error } = await db.rpc("register_claim_photo", { p_claim_id: parsed.data.claimId, p_storage_path: parsed.data.path }).single();
  if (error) {
    if (!error.details) console.error("[claims] register_claim_photo:", error.code, error.message);
    return { ok: false, message: claimErrorMessage(error) };
  }
  return { ok: true };
}
