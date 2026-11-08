import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { requireArea } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { ActionResult } from "./action-result";

/**
 * For admin Server Actions: checks the session through the DAL (redirects otherwise) and returns a
 * Supabase client acting as the admin, so RLS enforces the admin role a second time.
 */
export async function adminAction() {
  const ctx = await requireArea("admin");
  return { ctx, db: await createClient() };
}

/**
 * Writes an audit_log entry (service role; audit_log is server-write only and append-only, D65).
 * The author's id and e-mail are stored in the row, so the entry keeps its author even if the account is
 * deleted later. `data` holds ids and changed business values only — never customers' personal data
 * (addresses, phone numbers, …). Never throws.
 */
export async function audit(
  actor: { userId: string; email: string },
  action: string,
  entityType: string,
  entityId: string | null,
  data: Record<string, unknown> = {},
) {
  const { error } = await createServiceClient()
    .from("audit_log")
    .insert({ actor_id: actor.userId, actor_email: actor.email, action, entity_type: entityType, entity_id: entityId, data });
  if (error) console.error("[audit] insert failed", { action, code: error.code, message: error.message });
}

/** Maps a database error to an Italian message for the admin. */
export function dbError(error: PostgrestError | null, fallback = "Operazione non riuscita."): ActionResult {
  if (!error) return { error: fallback };
  console.error("[admin] db error", { code: error.code, message: error.message });
  const msg = error.message ?? "";
  if (/read-only|Only draft/i.test(msg)) return { error: "Il listino pubblicato non è modificabile. Crea una nuova bozza." };
  if (/missing rates/i.test(msg)) return { error: "Listino incompleto: mancano le tariffe di uno o più veicoli attivi." };
  if (/missing .* pricing rule/i.test(msg)) return { error: "Listino incompleto: mancano una o più regole." };
  if (error.code === "23505") return { error: "Valore già presente (deve essere unico)." };
  if (error.code === "23514" || error.code === "22P02" || error.code === "23502") return { error: "Valore non valido." };
  if (error.code === "42501") return { error: "Operazione non consentita." };
  return { error: fallback };
}

export const ok = (message: string): ActionResult => ({ message, at: Date.now() });
