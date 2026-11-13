import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatWorkedMinutes, hasAnyPorters, porterSummaries, porterTermsOfLeg, type LegStep, type PhotoKind, type PorterLegColumns, type PorterSummary, type PorterTimeSide, type WorkedRow } from "@/lib/carriers/execution";
import { customerVisiblePhotos, isDeliveredStatus, isLoadedOrLater } from "./execution-view";

// Job execution as the customer and the admin see it (POD, photos, steps, porter time). Everything is read with the
// caller's OWN session — RLS and the storage policies decide what comes back; never the service role. Signed URLs
// live 5 minutes (a reload makes new ones). Tests: tests/rls/order-execution-views.test.ts.

export const SIGNED_URL_SECONDS = 300;

type DbErrorish = { code?: string; message?: string } | null;

function fail(where: string, error: DbErrorish): never {
  console.error(`[execution-read] ${where}:`, error?.code ?? "", error?.message ?? ""); // ids only
  throw new Error("execution unavailable");
}

/** Path → signed URL (missing entries = the storage refused or the file is gone; shown as "non disponibile"). */
async function signUrls(db: SupabaseClient, bucket: "order-photos" | "pod-signatures", paths: string[]): Promise<Map<string, string>> {
  if (!paths.length) return new Map();
  const { data, error } = await db.storage.from(bucket).createSignedUrls(paths, SIGNED_URL_SECONDS);
  if (error) {
    console.error(`[execution-read] sign ${bucket}:`, error.message);
    return new Map();
  }
  return new Map((data ?? []).filter((s) => s.signedUrl && s.path && !s.error).map((s) => [s.path as string, s.signedUrl as string]));
}

export type ViewPhoto = { id: string; legIndex: number; kind: PhotoKind; createdAt: string; url: string | null };

type PhotoRow = { id: string; leg_index: number; kind: PhotoKind; storage_path: string; created_at: string };

async function photoRows(db: SupabaseClient, orderId: string): Promise<PhotoRow[]> {
  const { data, error } = await db
    .from("order_photos")
    .select("id, leg_index, kind, storage_path, created_at")
    .eq("order_id", orderId)
    .order("created_at")
    .returns<PhotoRow[]>();
  if (error) fail("photos", error);
  return data ?? [];
}

async function withUrls(db: SupabaseClient, rows: PhotoRow[]): Promise<ViewPhoto[]> {
  const urls = await signUrls(db, "order-photos", rows.map((p) => p.storage_path));
  return rows.map((p) => ({ id: p.id, legIndex: p.leg_index, kind: p.kind, createdAt: p.created_at, url: urls.get(p.storage_path) ?? null }));
}

/** Package porters (order_porters_worked_minutes) and help per side (order_loading_help_minutes, D182). */
async function workedMinutes(db: SupabaseClient, orderId: string): Promise<WorkedRow[]> {
  const [pkg, help] = await Promise.all([
    db.rpc("order_porters_worked_minutes", { p_order_id: orderId }),
    db.rpc("order_loading_help_minutes", { p_order_id: orderId }),
  ]);
  if (pkg.error) fail("porter minutes", pkg.error);
  if (help.error) fail("loading help minutes", help.error);
  return [...((pkg.data ?? []) as WorkedRow[]), ...((help.data ?? []) as WorkedRow[])];
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export type CustomerPorterTime = { legIndex: number; side: PorterTimeSide; workedLabel: string; includedLabel: string; complete: boolean };

export type CustomerExecutionView = {
  photos: ViewPhoto[];
  /** After the delivery with POD only. */
  proof: { recipientName: string; signedAt: string; signatureUrl: string | null } | null;
  /** Legs with porters once their work is measured or the goods are loaded; time only, never amounts (Stage 6, D69). */
  porters: CustomerPorterTime[];
};

type CustomerLeg = PorterLegColumns;

/**
 * The customer's view of its own order (the page already loaded the order with the same session, so it is the
 * customer's). Pickup photos after loading, the rest after the delivery (customerVisiblePhotos). No positions.
 */
export async function loadCustomerExecution(
  db: SupabaseClient,
  order: { id: string; status: string; order_legs: readonly CustomerLeg[] },
): Promise<CustomerExecutionView> {
  const delivered = isDeliveredStatus(order.status);
  const hasPorters = order.order_legs.some(hasAnyPorters);
  const [rows, proofRes, worked] = await Promise.all([
    photoRows(db, order.id),
    delivered
      ? db.from("delivery_proofs").select("recipient_name, signature_path, signed_at").eq("order_id", order.id)
          .maybeSingle<{ recipient_name: string; signature_path: string; signed_at: string }>()
      : Promise.resolve({ data: null, error: null }),
    hasPorters ? workedMinutes(db, order.id) : Promise.resolve([] as WorkedRow[]),
  ]);
  if (proofRes.error) fail("proof", proofRes.error);

  const photos = await withUrls(db, customerVisiblePhotos(order.status, rows));
  const proofRow = proofRes.data;
  const signature = proofRow ? await signUrls(db, "pod-signatures", [proofRow.signature_path]) : new Map<string, string>();

  const porters = order.order_legs
    .flatMap(porterTermsOfLeg)
    .map((t) => ({ t, row: worked.find((w) => w.leg_index === t.legIndex && (w.side ?? "both") === (t.side ?? "both")) }))
    .filter(({ row }) => row && (row.worked_minutes > 0 || row.complete || isLoadedOrLater(order.status)))
    .sort((a, b) => a.t.legIndex - b.t.legIndex)
    .map(({ t, row }) => ({
      legIndex: t.legIndex,
      side: t.side ?? "both",
      workedLabel: formatWorkedMinutes(row!.worked_minutes),
      includedLabel: `${t.includedHours} h`,
      complete: row!.complete,
    }));

  return {
    photos,
    proof: proofRow ? { recipientName: proofRow.recipient_name, signedAt: proofRow.signed_at, signatureUrl: signature.get(proofRow.signature_path) ?? null } : null,
    porters,
  };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type AdminStep = {
  id: number; legIndex: number; step: LegStep; createdAt: string; createdBy: string;
  lat: number | null; lng: number | null; revertedAt: string | null; revertedBy: string | null;
};
export type AdminNote = { id: number; kind: string; legIndex: number | null; body: string; createdBy: string; createdAt: string };

export type AdminExecutionView = {
  steps: AdminStep[];
  photos: ViewPhoto[];
  proof: { recipientName: string; signedAt: string; signatureUrl: string | null; createdBy: string; lat: number | null; lng: number | null } | null;
  porters: PorterSummary[];
  notes: AdminNote[];
  /** Every user id above (steps, reverts, POD, notes) — the page resolves them to names. */
  actorIds: string[];
};

type AdminLeg = PorterLegColumns;

/** The admin's view (admin session; admin_order_execution / admin_delivery_proof check is_admin() themselves). */
export async function loadAdminExecution(
  db: SupabaseClient,
  order: { id: string; order_legs: readonly AdminLeg[] },
): Promise<AdminExecutionView> {
  const hasPorters = order.order_legs.some(hasAnyPorters);
  const [stepsRes, proofRes, notesRes, rows, worked, rateRes] = await Promise.all([
    db.rpc("admin_order_execution", { p_order_id: order.id }),
    db.rpc("admin_delivery_proof", { p_order_id: order.id }),
    db.from("order_admin_notes").select("id, kind, leg_index, body, created_by, created_at").eq("order_id", order.id).order("id")
      .returns<{ id: number; kind: string; leg_index: number | null; body: string; created_by: string; created_at: string }[]>(),
    photoRows(db, order.id),
    hasPorters ? workedMinutes(db, order.id) : Promise.resolve([] as WorkedRow[]),
    hasPorters
      ? db.from("order_charges").select("porter_overtime_rate_cents").eq("order_id", order.id).maybeSingle<{ porter_overtime_rate_cents: number | null }>()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (stepsRes.error) fail("admin_order_execution", stepsRes.error);
  if (proofRes.error) fail("admin_delivery_proof", proofRes.error);
  if (notesRes.error) fail("notes", notesRes.error);
  if (rateRes.error) fail("overtime rate", rateRes.error);

  type StepDb = { id: number; leg_index: number; step: LegStep; created_at: string; created_by: string; lat: number | null; lng: number | null; reverted_at: string | null; reverted_by: string | null };
  type ProofDb = { recipient_name: string; signature_path: string; signed_at: string; created_by: string; lat: number | null; lng: number | null };
  const steps = ((stepsRes.data ?? []) as StepDb[]).map((s) => ({
    id: s.id, legIndex: s.leg_index, step: s.step, createdAt: s.created_at, createdBy: s.created_by,
    lat: s.lat, lng: s.lng, revertedAt: s.reverted_at, revertedBy: s.reverted_by,
  }));
  const proofRow = ((proofRes.data ?? []) as ProofDb[])[0] ?? null;
  const [photos, signature] = await Promise.all([
    withUrls(db, rows),
    proofRow ? signUrls(db, "pod-signatures", [proofRow.signature_path]) : Promise.resolve(new Map<string, string>()),
  ]);
  const notes = (notesRes.data ?? []).map((n) => ({ id: n.id, kind: n.kind, legIndex: n.leg_index, body: n.body, createdBy: n.created_by, createdAt: n.created_at }));

  const terms = order.order_legs.flatMap(porterTermsOfLeg);
  const porters = porterSummaries(terms, worked, (rateRes.data?.porter_overtime_rate_cents ?? 0) > 0);

  const actorIds = [
    ...steps.flatMap((s) => [s.createdBy, s.revertedBy]),
    proofRow?.created_by ?? null,
    ...notes.map((n) => n.createdBy),
  ].filter((x): x is string => !!x);

  return {
    steps,
    photos,
    proof: proofRow
      ? { recipientName: proofRow.recipient_name, signedAt: proofRow.signed_at, signatureUrl: signature.get(proofRow.signature_path) ?? null, createdBy: proofRow.created_by, lat: proofRow.lat, lng: proofRow.lng }
      : null,
    porters,
    notes,
    actorIds: [...new Set(actorIds)],
  };
}
