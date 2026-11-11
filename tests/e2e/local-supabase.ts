import { execFileSync } from "node:child_process";
import { assertLocalTarget } from "../rls/target";

// End-to-end tests run ONLY against this repo's local Supabase stack (D64), like the RLS tests: URL and keys come
// from `supabase status`, anything that is not http://127.0.0.1:55321 is refused.
export type LocalSupabase = { url: string; anonKey: string; serviceKey: string };

let cached: LocalSupabase | null = null;

export function localSupabase(): LocalSupabase {
  if (cached) return cached;
  const out = execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const s = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string>;
  const url = assertLocalTarget(s.API_URL);
  cached = { url, anonKey: s.ANON_KEY, serviceKey: s.SERVICE_ROLE_KEY };
  return cached;
}
