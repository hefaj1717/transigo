"use server";

// Service area (D13, D61) and booking settings (D50, D62).
import { refresh } from "next/cache";
import { z } from "zod";
import { adminAction, audit, dbError, ok } from "@/lib/admin/server";
import type { ActionResult } from "@/lib/admin/action-result";

const settingsSchema = z.object({
  max_km: z.coerce.number().int().min(1).max(2000),
  min_booking_lead_hours: z.coerce.number().int().min(0).max(168),
  quote_valid_minutes: z.coerce.number().int().min(1).max(1440),
});

export async function updateAreaSettingsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const parsed = settingsSchema.safeParse({
    max_km: fd.get("max_km"),
    min_booking_lead_hours: fd.get("min_booking_lead_hours"),
    quote_valid_minutes: fd.get("quote_valid_minutes"),
  });
  if (!parsed.success) return { error: "Controlla i valori (km 1–2000, preavviso 0–168 h, validità 1–1440 min)." };
  const patch = {
    max_route_distance_m: parsed.data.max_km * 1000, // admin types km, stored in metres
    min_booking_lead_hours: parsed.data.min_booking_lead_hours,
    quote_valid_minutes: parsed.data.quote_valid_minutes,
  };
  const { data, error } = await db.from("settings").update(patch).eq("id", true).select("id");
  if (error || !data?.length) return dbError(error);
  await audit(ctx.userId, "settings.service_area", "settings", null, patch);
  refresh();
  return ok("Impostazioni salvate.");
}

/** Saves the active flags of all provinces of one region (checked = active). */
export async function updateRegionAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const region = String(fd.get("region") ?? "");
  const all = fd.getAll("province").map(String).filter((c) => /^[A-Z]{2}$/.test(c));
  const active = new Set(fd.getAll("active").map(String));
  if (!region || !all.length) return { error: "Regione non valida." };

  const on = all.filter((c) => active.has(c));
  const off = all.filter((c) => !active.has(c));
  for (const [codes, isActive] of [[on, true], [off, false]] as const) {
    if (!codes.length) continue;
    const { error } = await db.from("service_area_provinces").update({ is_active: isActive }).eq("region_it", region).in("province_code", codes);
    if (error) return dbError(error);
  }
  await audit(ctx.userId, "service_area.update", "service_area_provinces", null, { region, active: on });
  refresh();
  return ok(`${region}: ${on.length} province attive.`);
}
