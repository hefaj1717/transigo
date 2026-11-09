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

/**
 * After `db reset` the database restarts and PostgREST rebuilds its schema cache; requests made before that
 * fail with "Could not query the database for the schema cache". Waits until a REST query succeeds (max 60 s).
 */
async function waitForRest(url: string, serviceKey: string) {
  const deadline = Date.now() + 60_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/rest/v1/settings?select=id&limit=1`, { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } });
      if (res.ok) return;
      last = `${res.status} ${await res.text()}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Local REST API not ready 60 s after the reset: ${last}`);
}

export default async function setup(project: TestProject) {
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
  await waitForRest(url, serviceKey);

  project.provide("supabase", { url, anonKey, serviceKey });
}
