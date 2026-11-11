"use server";

// "Impostazioni" (spec 9): Transigo's company data and the rules (cancellation D33/D137, payout window D4, alert for
// paid orders without a carrier). Saved with the admin's session (RLS + column GRANTs on settings); the audit keeps
// the changed fields and values (Transigo's own data, no customers' data). EVERY action starts with adminAction()
// (DAL); actions.test.ts calls every export as a non-admin.
import { refresh, revalidateTag } from "next/cache";
import type { ActionResult } from "@/lib/admin/action-result";
import { adminAction, audit, dbError, ok } from "@/lib/admin/server";
import { changedFields, COMPANY_FIELDS, COMPANY_INFO_CACHE_TAG, companySchema, RULES_ERROR, rulesSchema } from "@/lib/admin/settings";

const RULE_FIELDS = ["free_cancellation_hours", "late_cancellation_fee_bp", "payout_window_hours", "unassigned_alert_hours"] as const;

const values = (fd: FormData, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, typeof fd.get(k) === "string" ? (fd.get(k) as string) : ""]));

export async function updateCompanyAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const parsed = companySchema.safeParse(values(fd, COMPANY_FIELDS));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Controlla i campi." };

  const { data: before, error: readError } = await db.from("settings").select(COMPANY_FIELDS.join(", ")).single();
  if (readError) return dbError(readError);
  const patch = changedFields(before as unknown as Record<string, unknown>, parsed.data);
  if (!Object.keys(patch).length) return ok("Nessuna modifica.");

  const { data, error } = await db.from("settings").update(patch).eq("id", true).select("id");
  if (error || !data?.length) return dbError(error);
  await audit(ctx, "settings.company", "settings", null, patch);
  revalidateTag(COMPANY_INFO_CACHE_TAG, "max"); // footer of the public pages
  refresh();
  return ok("Dati aziendali salvati.");
}

export async function updateRulesAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { ctx, db } = await adminAction();
  const parsed = rulesSchema.safeParse(values(fd, RULE_FIELDS));
  if (!parsed.success) return { error: parsed.error.issues.find((i) => i.path[0] === "late_cancellation_fee_bp")?.message ?? RULES_ERROR };

  const { data: before, error: readError } = await db.from("settings").select(RULE_FIELDS.join(", ")).single();
  if (readError) return dbError(readError);
  const patch = changedFields(before as unknown as Record<string, unknown>, parsed.data);
  if (!Object.keys(patch).length) return ok("Nessuna modifica.");

  const { data, error } = await db.from("settings").update(patch).eq("id", true).select("id");
  if (error || !data?.length) return dbError(error);
  await audit(ctx, "settings.rules", "settings", null, { before: Object.fromEntries(Object.keys(patch).map((k) => [k, (before as unknown as Record<string, unknown>)[k]])), after: patch });
  refresh();
  return ok("Regole salvate.");
}
