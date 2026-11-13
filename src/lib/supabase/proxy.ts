import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "./env";

const PANEL_PREFIXES = ["/cliente", "/padroncino", "/admin"];

// Refreshes the Supabase auth session on every matched request and forwards
// updated cookies to both the request (for Server Components) and the response (for the browser).
// It also does an *optimistic* check (D46): no session on a panel path → /accedi.
// Role, blocked and carrier-status checks are NOT done here (no DB queries in the proxy);
// they run in every protected page through the DAL (src/lib/auth/session.ts).
export async function updateSession(request: NextRequest) {
  const { url, anonKey } = getSupabaseEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Do not run code between createServerClient and getClaims(): it refreshes an expired session and
  // verifies the token locally with the project's JWKS (D184) — no Supabase Auth round trip per request.
  const { data: claimsData } = await supabase.auth.getClaims();
  const user = claimsData?.claims?.sub ? { id: claimsData.claims.sub } : null;

  const { pathname, search } = request.nextUrl;
  if (!user && PANEL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const url = request.nextUrl.clone();
    url.pathname = "/accedi";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    const redirect = NextResponse.redirect(url);
    // Keep any cookies Supabase just updated (e.g. cleared an expired session).
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }

  return response;
}
