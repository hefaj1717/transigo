import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { localSupabase } from "./local-supabase";

// Fresh local database for every run (D64): reset → demo seed → test jobs per project (written to a JSON file).
export const JOBS_FILE = "test-results/e2e-jobs.json";

export default async function globalSetup() {
  localSupabase(); // refuses anything but the local stack before touching it
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  run("npm", ["run", "db:local:reset"]);
  await waitForRest();
  run("npm", ["run", "db:local:seed-demo"]);
  const out = run("node", ["scripts/seed-e2e-jobs.mjs", "iphone", "android"]).trim().split("\n").at(-1) ?? "{}";
  mkdirSync("test-results", { recursive: true });
  writeFileSync(JOBS_FILE, out);
}

async function waitForRest() {
  const { url, serviceKey } = localSupabase();
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${url}/rest/v1/settings?select=id&limit=1`, { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } }).catch(() => null);
    if (res?.ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("local REST API not ready after the reset");
}
