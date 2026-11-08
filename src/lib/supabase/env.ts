// Public Supabase config (safe to expose to the browser).
// The service role key is intentionally NOT read here: it must only ever be used
// in a dedicated server-only module (added later, when privileged operations exist).
export function getSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY (set them in .env.local)",
    );
  }
  return { url, anonKey };
}
