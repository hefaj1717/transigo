"use server";

// National holidays (D27) used for the weekend/holiday surcharge (D51).
import { refresh } from "next/cache";
import { z } from "zod";
import { adminAction, audit, dbError, ok } from "@/lib/admin/server";
import type { ActionResult } from "@/lib/admin/action-result";

const date = z.iso.date();

export async function addHolidayAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const parsed = z.object({ date, name_it: z.string().trim().min(2).max(80) }).safeParse({ date: fd.get("date"), name_it: fd.get("name_it") });
  if (!parsed.success) return { error: "Inserisci data e nome." };
  const { error } = await db.from("holidays").insert(parsed.data);
  if (error) return error.code === "23505" ? { error: "Esiste già una festività in questa data." } : dbError(error);
  await audit(ctx, "holiday.add", "holiday", null, parsed.data);
  refresh();
  return ok("Festività aggiunta.");
}

export async function deleteHolidayAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const parsed = date.safeParse(fd.get("date"));
  if (!parsed.success) return { error: "Data non valida." };
  const { data, error } = await db.from("holidays").delete().eq("date", parsed.data).select("date");
  if (error || !data?.length) return dbError(error);
  await audit(ctx, "holiday.delete", "holiday", null, { date: parsed.data });
  refresh();
  return ok("Eliminata.");
}
