// Public Supabase config (safe to expose to the browser).
// The service role key is intentionally NOT read here: it is only read in the server-only module service.ts.
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

// Public base URL of the app (no trailing slash), used for links in auth e-mails.
export function getAppUrl() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) throw new Error("Missing NEXT_PUBLIC_APP_URL (set it in .env.local)");
  return appUrl.replace(/\/+$/, "");
}
