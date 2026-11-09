import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CarrierStatus } from "@/lib/auth/routing";
import { ACTIVE_JOB_STATUSES } from "./admin";
import type { CarrierDocumentRow } from "./documents";
import type { CarrierDocumentType } from "./document-types";

// Reads for /admin/padroncini, always with the ADMIN's own session (RLS: admin reads every carrier, vehicle,
// document and file). Never the service role.

const fail = (what: string, code?: string) => new Error(`${what} unavailable: ${code ?? ""}`);

export type AdminCarrierListRow = {
  profile_id: string;
  status: CarrierStatus;
  status_reason: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  activated_at: string | null;
  created_at: string;
  company_name: string;
  vat_number: string;
  profiles: { email: string; first_name: string | null; last_name: string | null } | null;
};

export async function loadAdminCarriers(db: SupabaseClient): Promise<AdminCarrierListRow[]> {
  const { data, error } = await db
    .from("carriers")
    .select("profile_id, status, status_reason, submitted_at, decided_at, activated_at, created_at, company_name, vat_number, profiles!carriers_profile_id_fkey(email, first_name, last_name)")
    .order("created_at", { ascending: false })
    .limit(1000)
    .returns<AdminCarrierListRow[]>();
  if (error) throw fail("carriers", error.code);
  return data ?? [];
}

export type PendingVehicleRow = {
  id: string;
  plate: string;
  payload_kg: number;
  approved_at: string | null;
  first_approved_at: string | null;
  updated_at: string;
  carrier_id: string;
  vehicle_types: { name_it: string } | null;
  carriers: { company_name: string; status: CarrierStatus };
};

/** "Veicoli da verificare" (D114): active vehicles without approval of active / suspended carriers. */
export async function loadPendingVehicles(db: SupabaseClient): Promise<PendingVehicleRow[]> {
  const { data, error } = await db
    .from("carrier_vehicles")
    .select("id, plate, payload_kg, approved_at, first_approved_at, updated_at, carrier_id, vehicle_types(name_it), carriers!inner(company_name, status)")
    .eq("is_active", true)
    .is("approved_at", null)
    .in("carriers.status", ["active", "suspended"])
    .order("updated_at")
    .returns<PendingVehicleRow[]>();
  if (error) throw fail("pending vehicles", error.code);
  return data ?? [];
}

export type PendingDocumentRow = {
  id: string;
  doc_type: CarrierDocumentType;
  expires_at: string | null;
  created_at: string;
  carrier_id: string;
  vehicle_id: string | null;
  carriers: { company_name: string; status: CarrierStatus };
  carrier_vehicles: { plate: string; is_active: boolean } | null;
};

/** "Documenti da verificare" (D113): pending documents of active / suspended carriers. */
export async function loadPendingDocuments(db: SupabaseClient): Promise<PendingDocumentRow[]> {
  const { data, error } = await db
    .from("carrier_documents")
    .select("id, doc_type, expires_at, created_at, carrier_id, vehicle_id, carriers!inner(company_name, status), carrier_vehicles(plate, is_active)")
    .eq("review_status", "pending")
    .in("carriers.status", ["active", "suspended"])
    .order("created_at")
    .returns<PendingDocumentRow[]>();
  if (error) throw fail("pending documents", error.code);
  return data ?? [];
}

/** carrier_onboarding_missing() as the admin (allowed for admins, D99). */
export async function loadMissing(db: SupabaseClient, carrierId: string): Promise<string[]> {
  const { data, error } = await db.rpc("carrier_onboarding_missing", { p_carrier_id: carrierId });
  if (error) throw fail("missing", error.code);
  return (data as string[] | null) ?? [];
}

export type AdminCarrierDetail = AdminCarrierListRow & {
  fiscal_code: string | null;
  pec: string | null;
  sdi_code: string | null;
  hq_street: string | null;
  hq_city: string | null;
  hq_postal_code: string | null;
  hq_province: string | null;
  phone_verified_at: string | null;
  stripe_payouts_enabled: boolean;
  profiles: { email: string; first_name: string | null; last_name: string | null; phone: string | null; is_blocked: boolean } | null;
};

export async function loadAdminCarrier(db: SupabaseClient, id: string): Promise<AdminCarrierDetail | null> {
  const { data, error } = await db
    .from("carriers")
    .select("profile_id, status, status_reason, submitted_at, decided_at, activated_at, created_at, company_name, vat_number, fiscal_code, pec, sdi_code, hq_street, hq_city, hq_postal_code, hq_province, phone_verified_at, stripe_payouts_enabled, profiles!carriers_profile_id_fkey(email, first_name, last_name, phone, is_blocked)")
    .eq("profile_id", id)
    .maybeSingle<AdminCarrierDetail>();
  if (error) throw fail("carrier", error.code);
  return data;
}

export type AdminVehicleRow = {
  id: string;
  plate: string;
  payload_kg: number;
  cargo_length_cm: number | null;
  cargo_width_cm: number | null;
  cargo_height_cm: number | null;
  is_active: boolean;
  approved_at: string | null;
  first_approved_at: string | null;
  created_at: string;
  vehicle_types: { name_it: string } | null;
};

export async function loadAdminVehicles(db: SupabaseClient, carrierId: string): Promise<AdminVehicleRow[]> {
  const { data, error } = await db
    .from("carrier_vehicles")
    .select("id, plate, payload_kg, cargo_length_cm, cargo_width_cm, cargo_height_cm, is_active, approved_at, first_approved_at, created_at, vehicle_types(name_it)")
    .eq("carrier_id", carrierId)
    .order("is_active", { ascending: false })
    .order("created_at")
    .returns<AdminVehicleRow[]>();
  if (error) throw fail("vehicles", error.code);
  return data ?? [];
}

export type AdminDocumentRow = CarrierDocumentRow & { reviewed_at: string | null };

/** Every document of the carrier, newest first (older uploads stay visible to the admin). */
export async function loadAdminDocuments(db: SupabaseClient, carrierId: string): Promise<AdminDocumentRow[]> {
  const { data, error } = await db
    .from("carrier_documents")
    .select("id, doc_type, vehicle_id, expires_at, review_status, rejection_reason, file_name, mime_type, storage_path, created_at, reviewed_at")
    .eq("carrier_id", carrierId)
    .order("created_at", { ascending: false })
    .returns<AdminDocumentRow[]>();
  if (error) throw fail("documents", error.code);
  return data ?? [];
}

/** Jobs accepted and not yet delivered (D116): shown as a warning when suspending / while suspended. */
export async function countActiveJobs(db: SupabaseClient, carrierId: string): Promise<number> {
  const { count, error } = await db
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("carrier_id", carrierId)
    .in("status", [...ACTIVE_JOB_STATUSES]);
  if (error) throw fail("active jobs", error.code);
  return count ?? 0;
}
