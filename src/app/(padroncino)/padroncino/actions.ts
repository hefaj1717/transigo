"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireArea } from "@/lib/auth/session";
import { formDataToObject } from "@/lib/auth/schemas";
import type { CarrierFormState } from "@/lib/carriers/form-state";
import { CARRIER_PATHS, ONBOARDING_MSG } from "@/lib/carriers/onboarding";
import {
  createCarrierVehicle,
  registerCarrierDocument,
  saveCarrierCompany,
  setCarrierVehicleActive,
  submitCarrierForReview,
  updateCarrierVehicle,
} from "@/lib/carriers/server";
import { getAppUrl } from "@/lib/supabase/env";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";

// Carrier onboarding actions. The user id comes from the verified session (DAL), writes use the carrier's
// own session (RLS + column grants + triggers), never the service role. The state checks (D105, D109, D112)
// are in src/lib/carriers/server.ts.

const vehicleId = z.uuid();

async function run<T>(where: string, fn: () => Promise<T>): Promise<T | { ok: false; errors: { _form: string } }> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[carriers] ${where}:`, e instanceof Error ? e.message : e);
    return { ok: false, errors: { _form: ONBOARDING_MSG.generic } };
  }
}

export async function saveCompanyAction(_prev: CarrierFormState, formData: FormData): Promise<CarrierFormState> {
  const ctx = await requireArea("padroncino", CARRIER_PATHS.company);
  const input = formDataToObject(formData);
  const result = await run("saveCompany", async () => saveCarrierCompany(await createClient(), ctx.userId, input));
  if (!result.ok) return { errors: result.errors, values: input };
  revalidatePath(CARRIER_PATHS.home);
  return { message: "Dati aziendali salvati." };
}

export async function createVehicleAction(_prev: CarrierFormState, formData: FormData): Promise<CarrierFormState> {
  const ctx = await requireArea("padroncino", CARRIER_PATHS.newVehicle);
  const input = formDataToObject(formData);
  const result = await run("createVehicle", async () => createCarrierVehicle(await createClient(), ctx.userId, input));
  if (!result.ok) return { errors: result.errors, values: input };
  revalidatePath(CARRIER_PATHS.home);
  redirect(`${CARRIER_PATHS.vehicle(result.data.id)}?nuovo=1`); // next: the vehicle's documents
}

export async function updateVehicleAction(id: string, _prev: CarrierFormState, formData: FormData): Promise<CarrierFormState> {
  if (!vehicleId.safeParse(id).success) return { errors: { _form: "Veicolo non trovato." } };
  const ctx = await requireArea("padroncino", CARRIER_PATHS.vehicle(id));
  const input = formDataToObject(formData);
  const result = await run("updateVehicle", async () => updateCarrierVehicle(await createClient(), ctx.userId, id, input));
  if (!result.ok) return { errors: result.errors, values: input, offerNewVehicle: "offerNewVehicle" in result ? result.offerNewVehicle : undefined };
  revalidatePath(CARRIER_PATHS.vehicles);
  revalidatePath(CARRIER_PATHS.vehicle(id));
  return { message: "Veicolo salvato." };
}

export async function setVehicleActiveAction(_prev: CarrierFormState, formData: FormData): Promise<CarrierFormState> {
  const id = vehicleId.safeParse(formData.get("vehicleId"));
  if (!id.success) return { errors: { _form: "Veicolo non trovato." } };
  const active = formData.get("active") === "true";
  const ctx = await requireArea("padroncino", CARRIER_PATHS.vehicle(id.data));
  const result = await run("setVehicleActive", async () => setCarrierVehicleActive(await createClient(), ctx.userId, id.data, active));
  if (!result.ok) return { errors: result.errors };
  revalidatePath(CARRIER_PATHS.vehicles);
  revalidatePath(CARRIER_PATHS.vehicle(id.data));
  return { message: active ? "Veicolo riattivato." : "Veicolo disattivato." };
}

/** Called by the browser after it uploaded the file to Storage (D103). */
export async function registerDocumentAction(input: Record<string, string>): Promise<CarrierFormState> {
  const ctx = await requireArea("padroncino", CARRIER_PATHS.documents);
  const clean = Object.fromEntries(Object.entries(input ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const result = await run("registerDocument", async () => registerCarrierDocument(await createClient(), ctx.userId, clean));
  if (!result.ok) return { errors: result.errors };
  revalidatePath(CARRIER_PATHS.home);
  revalidatePath(CARRIER_PATHS.documents);
  if (vehicleId.safeParse(clean.vehicleId).success) revalidatePath(CARRIER_PATHS.vehicle(clean.vehicleId));
  return { message: "Documento caricato. Il team Transigo lo verificherà." };
}

export type SubmitActionState = { error?: string; missing?: string[] };

/** "Invia per la verifica" (D100, D106). On success the home page shows "Account in verifica". */
export async function submitForReviewAction(): Promise<SubmitActionState> {
  const ctx = await requireArea("padroncino", CARRIER_PATHS.home);
  const result = await run("submitForReview", async () =>
    submitCarrierForReview(await createClient(), ctx.userId, {
      serviceDb: createServiceClient(), // only for email_outbox
      adminEmail: process.env.ADMIN_NOTIFICATION_EMAIL?.trim() || null,
      appUrl: getAppUrl(),
    }),
  );
  if (!result.ok) return "errors" in result ? { error: result.errors._form } : { error: result.error, missing: result.missing };
  revalidatePath(CARRIER_PATHS.home);
  return {};
}
