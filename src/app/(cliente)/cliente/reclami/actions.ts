"use server";

import { after } from "next/server";
import { requireArea } from "@/lib/auth/session";
import { createClaimPhotoUpload, openClaim, registerClaimPhoto, type OpenClaimResult, type PhotoTicket } from "@/lib/claims/server";
import { getAppUrl } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// Claim Server Actions (D138). Each starts with the DAL; every database call uses the customer's own session;
// the service role only for the team e-mail after a successful open_claim (inside openClaim).

export async function openClaimAction(input: unknown): Promise<OpenClaimResult> {
  await requireArea("cliente", "/cliente/reclami");
  return openClaim(await createClient(), {
    service: createServiceClient,
    appUrl: getAppUrl(),
    adminEmail: process.env.ADMIN_NOTIFICATION_EMAIL?.trim() || null,
    defer: after,
  }, input);
}

export async function createClaimPhotoUploadAction(input: unknown): Promise<PhotoTicket> {
  await requireArea("cliente", "/cliente/reclami");
  return createClaimPhotoUpload(await createClient(), input);
}

export async function registerClaimPhotoAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireArea("cliente", "/cliente/reclami");
  return registerClaimPhoto(await createClient(), input);
}
