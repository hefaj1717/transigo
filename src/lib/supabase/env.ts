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

// Public base URL of the app (no trailing slash): links in e-mails, Stripe Checkout return URLs, metadataBase.
// NEXT_PUBLIC_APP_URL when set (local: .env.local); else, on Vercel, the project's production domain from the system
// variable VERCEL_PROJECT_PRODUCTION_URL (host only, e.g. "transigo-transi-go.vercel.app") — so a Vercel project
// needs no APP_URL of its own and never links to localhost. `null` when neither is set.
export function appUrlOrNull(): string | null {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelHost) return `https://${vercelHost.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return null;
}

export function getAppUrl() {
  const appUrl = appUrlOrNull();
  if (!appUrl) throw new Error("Missing NEXT_PUBLIC_APP_URL (set it in .env.local; on Vercel VERCEL_PROJECT_PRODUCTION_URL is used)");
  return appUrl;
}
