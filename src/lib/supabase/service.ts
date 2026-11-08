import "server-only";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./env";

// Service-role client: BYPASSES RLS. Server-only (the "server-only" import makes a client bundle fail to build).
// Use only for operations the schema reserves for the server (🔒 columns, customers/carriers inserts,
// reading the own profile of a blocked account), always scoped to an id taken from a verified session.
export function createServiceClient(): SupabaseClient {
  const { url } = getSupabaseEnv();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY (set it in .env.local)");
  return createSupabaseClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
