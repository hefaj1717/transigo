"use server";

// Price list admin actions (D59, D60). Every action re-checks the admin session through the DAL and
// writes with the admin's own Supabase client, so RLS and the draft-only triggers apply.
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { adminAction, audit, dbError, ok } from "@/lib/admin/server";
import type { ActionResult } from "@/lib/admin/action-result";
import { parseEuroToCents, parsePercentToBp } from "@/lib/pricing/money";
import { PORTER_PACKAGE_CODES, PRICE_RULE_CODES } from "@/lib/pricing/types";
import { PORTER_PACKAGE_LABEL, RULE_META } from "@/lib/pricing/rule-meta";

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
  await audit(ctx, "price_list.clone", "price_list", data as string, { source_id: sourceId });
  redirect(`/admin/listini/${data}`);
}

const settingsSchema = z.object({
  vat: z.string(),
  urgent_lead_hours: z.coerce.number().int().min(1).max(720),
  storage_short_term_max_days: z.coerce.number().int().min(1).max(3650),
  storage_billing_unit: z.enum(["day", "pallet_day"]),
  porter_overtime_grace_minutes: z.coerce.number().int().min(0).max(120),
  porters_min_hours: z.coerce.number().int().min(1).max(12), // D157
  porters_min_persons: z.coerce.number().int().min(1).max(4), // D177, D54
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
    porter_overtime_grace_minutes: str(fd, "porter_overtime_grace_minutes"),
    porters_min_hours: str(fd, "porters_min_hours"),
    porters_min_persons: str(fd, "porters_min_persons"),
    notes: str(fd, "notes"),
  });
  const vatBp = parsed.success ? parsePercentToBp(parsed.data.vat) : null;
  if (!id || !parsed.success || vatBp === null || vatBp > 10000) return { error: "Controlla i valori inseriti." };
  const patch = {
    vat_rate_bp: vatBp,
    urgent_lead_hours: parsed.data.urgent_lead_hours,
    storage_short_term_max_days: parsed.data.storage_short_term_max_days,
    storage_billing_unit: parsed.data.storage_billing_unit,
    porter_overtime_grace_minutes: parsed.data.porter_overtime_grace_minutes,
    porters_min_hours: parsed.data.porters_min_hours,
    porters_min_persons: parsed.data.porters_min_persons,
    notes: parsed.data.notes || null,
  };
  const { data, error } = await db.from("price_lists").update(patch).eq("id", id).select("id");
  if (error || !data?.length) return dbError(error);
  await audit(ctx, "price_list.update", "price_list", id, patch);
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
  await audit(ctx, "price_list.rates", "price_list", id, { rates: rows });
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
  await audit(ctx, "price_list.rules", "price_list", id, { rules: rows });
  refresh();
  return ok("Regole salvate.");
}

const packageSchema = z.object({
  porters_count: z.coerce.number().int().min(1).max(4), // D54
  included_hours: z.coerce.number().int().min(1).max(8),
});

/** Porter packages of a draft (D67): persons and included hours per load size. */
export async function updatePackagesAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = idFrom(fd);
  if (!id) return { error: "Listino non valido." };

  const rows = [];
  for (const code of PORTER_PACKAGE_CODES) {
    const parsed = packageSchema.safeParse({ porters_count: str(fd, `persons_${code}`), included_hours: str(fd, `hours_${code}`) });
    if (!parsed.success) return { error: `"${PORTER_PACKAGE_LABEL[code]}": persone 1–4, ore incluse 1–8.` };
    rows.push({ code, ...parsed.data, is_enabled: fd.get(`enabled_${code}`) === "on" });
  }

  const { data: existing, error: readError } = await db.from("price_list_porter_packages").select("code").eq("price_list_id", id);
  if (readError) return dbError(readError);
  const have = new Set((existing ?? []).map((r) => r.code as string));
  for (const { code, ...patch } of rows) {
    const { error } = have.has(code)
      ? await db.from("price_list_porter_packages").update(patch).eq("price_list_id", id).eq("code", code)
      : await db.from("price_list_porter_packages").insert({ price_list_id: id, code, ...patch });
    if (error) return dbError(error);
  }
  await audit(ctx, "price_list.porter_packages", "price_list", id, { packages: rows });
  refresh();
  return ok("Categorie facchinaggio salvate.");
}

const BOX_CODE = /^[a-z0-9_]{1,20}$/;

/** "3", "3,5" or "3.25" → 3.25 (m³, at most 2 decimals, 0 < v ≤ 100 as in the table check); else null. */
function parseVolume(raw: string): number | null {
  if (!/^\d{1,3}([.,]\d{1,2})?$/.test(raw)) return null;
  const value = Number(raw.replace(",", "."));
  return value > 0 && value <= 100 ? value : null;
}

type BoxPatch = { label_it: string; volume_m3: number; day_cents: number; month_cents: number; sort_order: number; is_enabled: boolean };

function parseBox(fd: FormData, prefix: string): BoxPatch | string {
  const label = str(fd, `label_${prefix}`);
  const volume = parseVolume(str(fd, `volume_${prefix}`));
  const day = parseEuroToCents(str(fd, `day_${prefix}`));
  const month = parseEuroToCents(str(fd, `month_${prefix}`));
  const order = z.coerce.number().int().min(0).max(999).safeParse(str(fd, `order_${prefix}`) || "0");
  if (label.length < 1 || label.length > 60) return "nome da 1 a 60 caratteri";
  if (volume === null) return "volume in m³ tra 0,01 e 100";
  if (!day || !month) return "prezzi al giorno e al mese maggiori di zero (es. 3,00)";
  if (!order.success) return "ordine 0–999";
  return { label_it: label, volume_m3: volume, day_cents: day, month_cents: month, sort_order: order.data, is_enabled: fd.get(`enabled_${prefix}`) === "on" };
}

/** Storage boxes of a draft (D154): edit existing ones (also disable) and optionally add one. */
export async function updateStorageBoxesAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = idFrom(fd);
  if (!id) return { error: "Listino non valido." };

  const { data: existing, error: readError } = await db.from("price_list_storage_boxes").select("code").eq("price_list_id", id);
  if (readError) return dbError(readError);
  const have = new Set((existing ?? []).map((r) => r.code as string));

  const updates: ({ code: string } & BoxPatch)[] = [];
  for (const code of fd.getAll("box_code").map(String)) {
    if (!have.has(code)) return { error: "Box non valido: ricarica la pagina." };
    const box = parseBox(fd, code);
    if (typeof box === "string") return { error: `Box "${code}": ${box}.` };
    updates.push({ code, ...box });
  }

  let added: ({ code: string } & BoxPatch) | null = null;
  const newCode = str(fd, "new_code").toLowerCase();
  const newFilled = ["label_new", "volume_new", "day_new", "month_new"].some((k) => str(fd, k) !== "");
  if (newCode || newFilled) {
    if (!BOX_CODE.test(newCode)) return { error: "Nuovo box: codice di 1–20 caratteri (lettere minuscole, cifre, _)." };
    if (have.has(newCode)) return { error: `Nuovo box: il codice "${newCode}" esiste già.` };
    const box = parseBox(fd, "new");
    if (typeof box === "string") return { error: `Nuovo box: ${box}.` };
    added = { code: newCode, ...box };
  }

  for (const { code, ...patch } of updates) {
    const { error } = await db.from("price_list_storage_boxes").update(patch).eq("price_list_id", id).eq("code", code);
    if (error) return dbError(error);
  }
  if (added) {
    const { error } = await db.from("price_list_storage_boxes").insert({ price_list_id: id, ...added });
    if (error) return dbError(error);
  }
  await audit(ctx, "price_list.storage_boxes", "price_list", id, { boxes: updates, added });
  refresh();
  return ok(added ? `Box salvati, aggiunto "${added.label_it}".` : "Box salvati.");
}

export async function publishListAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = idFrom(fd);
  if (!id) return { error: "Listino non valido." };
  const { error } = await db.rpc("publish_price_list", { p_price_list_id: id });
  if (error) return dbError(error);
  await audit(ctx, "price_list.publish", "price_list", id);
  refresh();
  return ok("Listino pubblicato: è ora quello attivo.");
}

export async function deleteDraftAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = idFrom(fd);
  if (!id) return { error: "Listino non valido." };
  const { data, error } = await db.from("price_lists").delete().eq("id", id).eq("status", "draft").select("id");
  if (error || !data?.length) return dbError(error);
  await audit(ctx, "price_list.delete", "price_list", id);
  redirect("/admin/listini");
}
