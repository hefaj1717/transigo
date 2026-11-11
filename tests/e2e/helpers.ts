import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { localSupabase } from "./local-supabase";

// Shared helpers of the end-to-end tests — LOCAL database only (D64).

export function serviceClient() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The seed password (never in the repo): SEED_PASSWORD or .seed-local/password. */
export function password(): string {
  if (process.env.SEED_PASSWORD) return process.env.SEED_PASSWORD;
  const file = path.join(process.cwd(), ".seed-local", "password");
  if (!existsSync(file)) throw new Error("seed password missing (.seed-local/password or SEED_PASSWORD)");
  return readFileSync(file, "utf8").trim();
}

export async function login(page: Page, next: string, email = "padroncino@example.com") {
  await page.goto(`/accedi?next=${encodeURIComponent(next)}`);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(password());
  await page.getByRole("button", { name: "Accedi" }).click();
  await page.waitForURL((u) => u.pathname === next);
}

/** The big button at the bottom of the carrier's job screen (sticky bar). */
export const mainButton = (page: Page, name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" });
