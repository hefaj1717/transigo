// Which Supabase instance the RLS tests may touch (D64).
//
// RLS tests create users, publish price lists and change settings, so they must never run against a
// shared project (staging / production). The only allowed target is this repo's local Supabase stack
// (`npm run db:local:start`), which listens on 55321 — not the default 54321, so the tests cannot hit
// another local Supabase project running on the same machine either.

export const LOCAL_API_URL = "http://127.0.0.1:55321";

/** Throws unless `url` is the local TransiGo stack. */
export function assertLocalTarget(url: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    throw new Error(`RLS tests: invalid Supabase URL ${JSON.stringify(url)}`);
  }
  const local = new URL(LOCAL_API_URL);
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "http:" || !isLoopback || parsed.port !== local.port || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error(
      `RLS tests refuse to run against ${parsed.origin}: only the local TransiGo stack (${LOCAL_API_URL}) is allowed. ` +
        "Never point them at staging or production.",
    );
  }
  return LOCAL_API_URL;
}
