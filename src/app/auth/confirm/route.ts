import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { loadAccountContext } from "@/lib/auth/account-context";
import { PATHS, resolvePostSignIn } from "@/lib/auth/routing";

// Target of the links in Supabase auth e-mails:
//   {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=<email|recovery|email_change>
// Uses verifyOtp(token_hash), so the link works on any device/browser (no PKCE verifier cookie needed).
const ALLOWED_TYPES = new Set<EmailOtpType>(["email", "signup", "recovery", "email_change"]);

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const to = (path: string) => NextResponse.redirect(new URL(path, request.url));

  if (!tokenHash || !type || !ALLOWED_TYPES.has(type)) {
    return to(`${PATHS.signIn}?errore=link`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) {
    console.error("[auth] confirm: verifyOtp", { code: error.code, status: error.status });
    return to(type === "recovery" ? `${PATHS.forgotPassword}?errore=link` : `${PATHS.signIn}?errore=link`);
  }

  if (type === "recovery") return to(PATHS.resetPassword);

  const ctx = await loadAccountContext(supabase, createServiceClient());
  return to(resolvePostSignIn(ctx));
}
