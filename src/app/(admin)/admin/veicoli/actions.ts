"use server";

// Vehicle types (D7, D22). Rates are not here: they belong to the price list version (D18).
import { refresh } from "next/cache";
import { z } from "zod";
import { adminAction, audit, dbError, ok } from "@/lib/admin/server";
import type { ActionResult } from "@/lib/admin/action-result";

const optionalPositiveInt = z.preprocess((v) => (v === "" ? null : v), z.coerce.number().int().positive().max(1_000_000).nullable());

const vehicleSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "Codice: lettere minuscole, cifre e _"),
  name_it: z.string().trim().min(2).max(80),
  payload_kg: optionalPositiveInt,
  cargo_length_cm: optionalPositiveInt,
  cargo_width_cm: optionalPositiveInt,
  cargo_height_cm: optionalPositiveInt,
  cargo_volume_dm3: optionalPositiveInt,
  size_rank: z.coerce.number().int().min(1).max(100),
  sort_order: z.coerce.number().int().min(0).max(10_000),
  is_active: z.boolean(),
});

function read(fd: FormData) {
  const s = (k: string) => String(fd.get(k) ?? "").trim();
  return vehicleSchema.safeParse({
    code: s("code"),
    name_it: s("name_it"),
    payload_kg: s("payload_kg"),
    cargo_length_cm: s("cargo_length_cm"),
    cargo_width_cm: s("cargo_width_cm"),
    cargo_height_cm: s("cargo_height_cm"),
    cargo_volume_dm3: s("cargo_volume_dm3"),
    size_rank: s("size_rank"),
    sort_order: s("sort_order") || "0",
    is_active: fd.get("is_active") === "on",
  });
}

function invalid(error: z.ZodError): ActionResult {
  const first = error.issues[0];
  return { error: `Valore non valido: ${String(first?.path[0] ?? "")}${first?.message.startsWith("Codice") ? ` (${first.message})` : ""}.` };
}

export async function updateVehicleAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const id = z.uuid().safeParse(String(fd.get("id") ?? ""));
  const parsed = read(fd);
  if (!id.success) return { error: "Veicolo non valido." };
  if (!parsed.success) return invalid(parsed.error);
  const { data, error } = await db.from("vehicle_types").update(parsed.data).eq("id", id.data).select("id");
  if (error || !data?.length) return dbError(error);
  await audit(ctx.userId, "vehicle_type.update", "vehicle_type", id.data, parsed.data);
  refresh();
  return ok("Salvato.");
}

export async function createVehicleAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const parsed = read(fd);
  if (!parsed.success) return invalid(parsed.error);
  const { data, error } = await db.from("vehicle_types").insert(parsed.data).select("id").single();
  if (error || !data) return dbError(error);
  await audit(ctx.userId, "vehicle_type.create", "vehicle_type", data.id, parsed.data);
  refresh();
  return ok("Veicolo aggiunto. Ricorda di aggiungere la tariffa in un nuovo listino.");
}
