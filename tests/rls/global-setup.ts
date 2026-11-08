import { execFileSync } from "node:child_process";
import type { TestProject } from "vitest/node";
import { assertLocalTarget } from "./target";

// Runs once before the RLS suite (D64):
//   1. reads URL and keys of the local Supabase stack from `supabase status` (no secrets in files),
//   2. refuses anything that is not the local TransiGo stack,
//   3. resets the local database (all migrations from the repo on an empty database), so every run starts
//      from the same state. Set RLS_SKIP_RESET=1 to skip the reset when iterating on a single test.

declare module "vitest" {
  export interface ProvidedContext {
    supabase: { url: string; anonKey: string; serviceKey: string };
  }
}

function supabase(args: string[]): string {
  return execFileSync("npx", ["supabase", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export default function setup(project: TestProject) {
  let status: Record<string, string>;
  try {
    status = JSON.parse(supabase(["status", "-o", "json"]));
  } catch {
    throw new Error("Local Supabase is not running. Start Docker, then: npm run db:local:start");
  }

  const url = assertLocalTarget(status.API_URL);
  const anonKey = status.ANON_KEY;
  const serviceKey = status.SERVICE_ROLE_KEY;
  if (!anonKey || !serviceKey) throw new Error("supabase status did not return ANON_KEY / SERVICE_ROLE_KEY");

  if (process.env.RLS_SKIP_RESET !== "1") {
    // No --remote flag: Supabase CLI 3.x resets the local stack by default, never the linked cloud project.
    supabase(["db", "reset", "--no-seed"]);
  }

  project.provide("supabase", { url, anonKey, serviceKey });
}
