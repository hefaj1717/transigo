import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CarrierStatus } from "@/lib/auth/routing";
import { carrierOnboardingView, type CarrierOnboardingView } from "./onboarding";
import type { CarrierDocumentRow } from "./documents";

// Reads for the carrier screens, always with the carrier's own session (RLS).

export type CarrierRow = {
  status: CarrierStatus;
  status_reason: string | null;
  submitted_at: string | null;
  phone_verified_at: string | null;
  stripe_payouts_enabled: boolean;
  company_name: string | null;
  vat_number: string | null;
  fiscal_code: string | null;
  hq_street: string | null;
  hq_city: string | null;
  hq_postal_code: string | null;
  hq_province: string | null;
  pec: string | null;
  sdi_code: string | null;
};

export async function loadCarrier(db: SupabaseClient, userId: string): Promise<{ carrier: CarrierRow | null; view: CarrierOnboardingView }> {
  const { data, error } = await db
    .from("carriers")
    .select("status, status_reason, submitted_at, phone_verified_at, stripe_payouts_enabled, company_name, vat_number, fiscal_code, hq_street, hq_city, hq_postal_code, hq_province, pec, sdi_code")
    .eq("profile_id", userId)
    .maybeSingle<CarrierRow>();
  if (error) throw new Error(`carrier unavailable: ${error.code}`);
  return { carrier: data, view: carrierOnboardingView(data?.status ?? null, data?.submitted_at ?? null) };
}

export type VehicleListRow = {
  id: string;
  vehicle_type_id: string;
  plate: string;
  payload_kg: number;
  cargo_length_cm: number | null;
  cargo_width_cm: number | null;
  cargo_height_cm: number | null;
  is_active: boolean;
  approved_at: string | null;
  first_approved_at: string | null;
  created_at: string;
};

const VEHICLE_COLUMNS = "id, vehicle_type_id, plate, payload_kg, cargo_length_cm, cargo_width_cm, cargo_height_cm, is_active, approved_at, first_approved_at, created_at";

export async function loadVehicles(db: SupabaseClient, userId: string): Promise<VehicleListRow[]> {
  const { data, error } = await db.from("carrier_vehicles").select(VEHICLE_COLUMNS).eq("carrier_id", userId).order("created_at");
  if (error) throw new Error(`vehicles unavailable: ${error.code}`);
  return (data ?? []) as VehicleListRow[];
}

export async function loadVehicle(db: SupabaseClient, userId: string, id: string): Promise<VehicleListRow | null> {
  const { data, error } = await db.from("carrier_vehicles").select(VEHICLE_COLUMNS).eq("carrier_id", userId).eq("id", id).maybeSingle();
  if (error) throw new Error(`vehicle unavailable: ${error.code}`);
  return data as VehicleListRow | null;
}

/** Active vehicle types the carrier can choose (RLS shows active types only). */
export async function loadVehicleTypes(db: SupabaseClient): Promise<{ id: string; name_it: string }[]> {
  const { data, error } = await db.from("vehicle_types").select("id, name_it").eq("is_active", true).order("sort_order");
  if (error) throw new Error(`vehicle types unavailable: ${error.code}`);
  return data ?? [];
}

const DOCUMENT_COLUMNS = "id, doc_type, vehicle_id, expires_at, review_status, rejection_reason, file_name, mime_type, storage_path, created_at";

export async function loadDocuments(db: SupabaseClient, userId: string, vehicleId?: string): Promise<CarrierDocumentRow[]> {
  let q = db.from("carrier_documents").select(DOCUMENT_COLUMNS).eq("carrier_id", userId);
  q = vehicleId ? q.eq("vehicle_id", vehicleId) : q.is("vehicle_id", null);
  const { data, error } = await q.order("created_at");
  if (error) throw new Error(`documents unavailable: ${error.code}`);
  return (data ?? []) as CarrierDocumentRow[];
}

/**
 * Short-lived links (5 min) to the carrier's own files, created with the carrier's session (storage policy:
 * own folder). HEIC is offered as a download — browsers do not display it (D103).
 */
export async function signedDocumentUrls(db: SupabaseClient, rows: readonly CarrierDocumentRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(rows.map(async (r) => {
    const { data } = await db.storage
      .from("carrier-documents")
      .createSignedUrl(r.storage_path, 300, r.mime_type === "image/heic" ? { download: r.file_name } : undefined);
    if (data?.signedUrl) out.set(r.id, data.signedUrl);
  }));
  return out;
}
