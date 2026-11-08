"use server";

// Price list admin actions (D59, D60). Every action re-checks the admin session through the DAL and
// writes with the admin's own Supabase client, so RLS and the draft-only triggers apply.
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { adminAction, audit, dbError, ok } from "@/lib/admin/server";
import type { ActionResult } from "@/lib/admin/action-result";
import { parseEuroToCents, parsePercentToBp } from "@/lib/pricing/money";
import { PRICE_RULE_CODES } from "@/lib/pricing/types";
import { RULE_META } from "@/lib/pricing/rule-meta";

const uuid = z.uuid();
const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

function idFrom(fd: FormData): string | null {
  const parsed = uuid.safeParse(str(fd, "id"));
  return parsed.success ? parsed.data : null;
}

export async function cloneListAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const sourceId = idFrom(fd);
  if (!sourceId) return { error: "Listino non valido." };
  const { data, error } = await db.rpc("clone_price_list", { p_source_id: sourceId });
  if (error || !data) return dbError(error);
  await audit(ctx.userId, "price_list.clone", "price_list", data as string, { source_id: sourceId });
  redirect(`/admin/listini/${data}`);
}

const settingsSchema = z.object({
  vat: z.string(),
  urgent_lead_hours: z.coerce.number().int().min(1).max(720),
  storage_short_term_max_days: z.coerce.number().int().min(1).max(3650),
  storage_billing_unit: z.enum(["day", "pallet_day"]),
  notes: z.string().max(1000),
});

export async function updateListSettingsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = idFrom(fd);
  const parsed = settingsSchema.safeParse({
    vat: str(fd, "vat"),
    urgent_lead_hours: str(fd, "urgent_lead_hours"),
    storage_short_term_max_days: str(fd, "storage_short_term_max_days"),
    storage_billing_unit: str(fd, "storage_billing_unit"),
    notes: str(fd, "notes"),
  });
  const vatBp = parsed.success ? parsePercentToBp(parsed.data.vat) : null;
  if (!id || !parsed.success || vatBp === null || vatBp > 10000) return { error: "Controlla i valori inseriti." };
  const patch = {
    vat_rate_bp: vatBp,
    urgent_lead_hours: parsed.data.urgent_lead_hours,
    storage_short_term_max_days: parsed.data.storage_short_term_max_days,
    storage_billing_unit: parsed.data.storage_billing_unit,
    notes: parsed.data.notes || null,
  };
  const { data, error } = await db.from("price_lists").update(patch).eq("id", id).select("id");
  if (error || !data?.length) return dbError(error);
  await audit(ctx.userId, "price_list.update", "price_list", id, patch);
  refresh();
  return ok("Impostazioni salvate.");
}

export async function updateRatesAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = idFrom(fd);
  if (!id) return { error: "Listino non valido." };

  const vehicleIds = fd.getAll("vehicle_type_id").map(String).filter((v) => uuid.safeParse(v).success);
  const rows: { vehicle_type_id: string; rate_per_km_cents: number; min_price_cents: number }[] = [];
  for (const vt of vehicleIds) {
    const rateRaw = str(fd, `rate_${vt}`);
    const minRaw = str(fd, `min_${vt}`);
    if (rateRaw === "" && minRaw === "") continue; // leave a vehicle without a rate
    const rate = parseEuroToCents(rateRaw);
    const min = parseEuroToCents(minRaw);
    if (rate === null || min === null) return { error: "Tariffe non valide: usa importi in euro, es. 1,40." };
    rows.push({ vehicle_type_id: vt, rate_per_km_cents: rate, min_price_cents: min });
  }

  const { data: existing, error: readError } = await db.from("price_list_vehicle_rates").select("vehicle_type_id").eq("price_list_id", id);
  if (readError) return dbError(readError);
  const have = new Set((existing ?? []).map((r) => r.vehicle_type_id as string));

  for (const row of rows) {
    const { error } = have.has(row.vehicle_type_id)
      ? await db.from("price_list_vehicle_rates").update({ rate_per_km_cents: row.rate_per_km_cents, min_price_cents: row.min_price_cents }).eq("price_list_id", id).eq("vehicle_type_id", row.vehicle_type_id)
      : await db.from("price_list_vehicle_rates").insert({ price_list_id: id, ...row });
    if (error) return dbError(error);
  }
  await audit(ctx.userId, "price_list.rates", "price_list", id, { rates: rows });
  refresh();
  return ok("Tariffe salvate.");
}

export async function updateRulesAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = idFrom(fd);
  if (!id) return { error: "Listino non valido." };

  const rows = [];
  for (const code of PRICE_RULE_CODES) {
    const kind = str(fd, `kind_${code}`);
    if (!RULE_META[code].kinds.includes(kind as never)) return { error: `Tipo non valido per "${RULE_META[code].label}".` };
    const raw = str(fd, `value_${code}`);
    const value = kind === "percent" ? parsePercentToBp(raw) : parseEuroToCents(raw);
    if (value === null) return { error: `Valore non valido per "${RULE_META[code].label}".` };
    if (kind === "percent" && code.startsWith("carrier_share_") && value > 10000) return { error: "La quota padroncino non può superare il 100%." };
    rows.push({
      code,
      kind,
      amount_cents: kind === "percent" ? null : value,
      percent_bp: kind === "percent" ? value : null,
      is_enabled: fd.get(`enabled_${code}`) === "on",
    });
  }

  const { data: existing, error: readError } = await db.from("price_rules").select("code").eq("price_list_id", id);
  if (readError) return dbError(readError);
  const have = new Set((existing ?? []).map((r) => r.code as string));
  for (const { code, ...patch } of rows) {
    const { error } = have.has(code)
      ? await db.from("price_rules").update(patch).eq("price_list_id", id).eq("code", code)
      : await db.from("price_rules").insert({ price_list_id: id, code, ...patch });
    if (error) return dbError(error);
  }
  await audit(ctx.userId, "price_list.rules", "price_list", id, { rules: rows });
  refresh();
  return ok("Regole salvate.");
}

export async function publishListAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = idFrom(fd);
  if (!id) return { error: "Listino non valido." };
  const { error } = await db.rpc("publish_price_list", { p_price_list_id: id });
  if (error) return dbError(error);
  await audit(ctx.userId, "price_list.publish", "price_list", id);
  refresh();
  return ok("Listino pubblicato: è ora quello attivo.");
}

export async function deleteDraftAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = idFrom(fd);
  if (!id) return { error: "Listino non valido." };
  const { data, error } = await db.from("price_lists").delete().eq("id", id).eq("status", "draft").select("id");
  if (error || !data?.length) return dbError(error);
  await audit(ctx.userId, "price_list.delete", "price_list", id);
  redirect("/admin/listini");
}
