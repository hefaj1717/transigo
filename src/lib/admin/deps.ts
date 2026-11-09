import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireArea } from "@/lib/auth/session";
import { getAppUrl } from "@/lib/supabase/env";
import { createServiceClient } from "@/lib/supabase/service";

/** What admin server code needs: the admin from the SESSION, a service-role client, the app URL. */
export type AdminDeps = {
  admin: { userId: string; email: string };
  /** Service-role client: database functions (they check the admin again), audit_log, email_outbox. */
  serviceDb: SupabaseClient;
  appUrl: string;
};

/**
 * First line of EVERY admin Server Action that uses the service role: the DAL checks the session (anonymous,
 * other roles and blocked accounts are redirected before anything else runs); the admin id is always the
 * session's — never a form field. The service-role client is created only after that check.
 */
export async function adminDeps(path: string): Promise<AdminDeps> {
  const ctx = await requireArea("admin", path);
  return { admin: { userId: ctx.userId, email: ctx.email }, serviceDb: createServiceClient(), appUrl: getAppUrl() };
}
