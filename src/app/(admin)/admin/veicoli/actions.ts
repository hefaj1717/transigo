"use server";

// Vehicle types (D7, D22). Rates are not here: they belong to the price list version (D18).
import { refresh } from "next/cache";
import { z } from "zod";
import { adminAction, audit, dbError, ok } from "@/lib/admin/server";
import type { ActionResult } from "@/lib/admin/action-result";
import { parseCubicMetresToDm3 } from "@/lib/admin/units";
import { PORTER_PACKAGE_CODES } from "@/lib/pricing/types";

// D81, D85: all capacity fields are required, so the vehicle recommendation can check every criterion.
const positiveInt = (max: number) => z.coerce.number().int().positive().max(max);

const vehicleSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name_it: z.string().trim().min(2).max(80),
  payload_kg: positiveInt(100_000),
  cargo_length_cm: positiveInt(2_000),
  cargo_width_cm: positiveInt(500),
  cargo_height_cm: positiveInt(500),
  cargo_volume_dm3: positiveInt(200_000),
  euro_pallets: z.coerce.number().int().min(0).max(100),
  size_rank: z.coerce.number().int().min(1).max(100),
  sort_order: z.coerce.number().int().min(0).max(10_000),
  is_active: z.boolean(),
});

const FIELD_LABEL: Record<string, string> = {
  code: "Codice (lettere minuscole, cifre e _)",
  name_it: "Nome",
  payload_kg: "Portata (kg)",
  cargo_length_cm: "Lunghezza (cm)",
  cargo_width_cm: "Larghezza (cm)",
  cargo_height_cm: "Altezza (cm)",
  cargo_volume_dm3: "Volume (m³, es. 9,5)",
  euro_pallets: "Pallet EUR (0 o più)",
  size_rank: "Classe di grandezza",
  sort_order: "Ordine",
};

function read(fd: FormData) {
  const s = (k: string) => String(fd.get(k) ?? "").trim();
  const volume = parseCubicMetresToDm3(s("cargo_volume_m3"));
  return vehicleSchema.safeParse({
    code: s("code"),
    name_it: s("name_it"),
    payload_kg: s("payload_kg") || undefined,
    cargo_length_cm: s("cargo_length_cm") || undefined,
    cargo_width_cm: s("cargo_width_cm") || undefined,
    cargo_height_cm: s("cargo_height_cm") || undefined,
    cargo_volume_dm3: volume ?? undefined,
    euro_pallets: s("euro_pallets") || undefined,
    size_rank: s("size_rank"),
    sort_order: s("sort_order") || "0",
    is_active: fd.get("is_active") === "on",
  });
}

function invalid(error: z.ZodError): ActionResult {
  const fields = [...new Set(error.issues.map((i) => FIELD_LABEL[String(i.path[0])] ?? String(i.path[0])))];
  return { error: `Controlla: ${fields.join(", ")}.` };
}

export async function updateVehicleAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = z.uuid().safeParse(String(fd.get("id") ?? ""));
  const parsed = read(fd);
  if (!id.success) return { error: "Veicolo non valido." };
  if (!parsed.success) return invalid(parsed.error);
  const { data, error } = await db.from("vehicle_types").update(parsed.data).eq("id", id.data).select("id");
  if (error || !data?.length) return dbError(error);
  await audit(ctx, "vehicle_type.update", "vehicle_type", id.data, parsed.data);
  refresh();
  return ok("Salvato.");
}

export async function createVehicleAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const parsed = read(fd);
  if (!parsed.success) return invalid(parsed.error);
  const { data, error } = await db.from("vehicle_types").insert(parsed.data).select("id").single();
  if (error || !data) return dbError(error);
  await audit(ctx, "vehicle_type.create", "vehicle_type", data.id, parsed.data);
  refresh();
  return ok("Veicolo aggiunto. Ricorda di aggiungere la tariffa in un nuovo listino.");
}

/** D83: minimum vehicle per load category ("" = no minimum). Not versioned; applies to new quotes at once. */
export async function saveCategoryMinimumsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const changes: Record<string, string | null> = {};
  for (const code of PORTER_PACKAGE_CODES) {
    const raw = String(fd.get(`min_${code}`) ?? "");
    if (raw && !z.uuid().safeParse(raw).success) return { error: "Veicolo non valido." };
    changes[code] = raw || null;
  }
  for (const [code, vehicleTypeId] of Object.entries(changes)) {
    const { error } = vehicleTypeId
      ? await db.from("porter_package_min_vehicle").upsert({ package_code: code, vehicle_type_id: vehicleTypeId })
      : await db.from("porter_package_min_vehicle").delete().eq("package_code", code);
    if (error) return dbError(error);
  }
  await audit(ctx, "vehicle_type.category_minimums", "porter_package_min_vehicle", null, changes);
  refresh();
  return ok("Veicoli minimi salvati.");
}
