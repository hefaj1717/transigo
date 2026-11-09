import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CarrierStatus } from "@/lib/auth/routing";
import { AUTH_MSG, isVatTakenError } from "@/lib/auth/errors";
import { carrierCompanyRow, carrierCompanySchema, toFieldErrors, type FieldErrors } from "@/lib/auth/schemas";
import { canEditOnboarding, carrierOnboardingView, ONBOARDING_MSG, vehicleEditBlock, type CarrierOnboardingView } from "./onboarding";
import { vehicleDbError, vehicleRow, vehicleSchema, VEHICLE_MSG } from "./vehicles";

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
