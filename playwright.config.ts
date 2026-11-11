import { defineConfig, devices } from "@playwright/test";
import { localSupabase } from "./tests/e2e/local-supabase";

// End-to-end tests: the carrier job screen in phone views, the admin's corrections on a desktop browser (npm run test:e2e) — LOCAL Supabase only (D64).
// Needs Docker + `npm run db:local:start`. global-setup resets the local database and seeds the demo + test jobs.
// The app runs as a production build in its own folder (.next-e2e) on port 3200, so a `npm run dev` on 3000 keeps
// working; the local keys are passed as environment variables (they win over .env.local, which points at staging).
// Not part of `npm test`.
const sb = localSupabase();
const PORT = 3200;
// E2E_HOST=192.168.x.y npm run test:e2e — the same run through the Wi-Fi address over plain http, like a phone in
// variant A (docs/testy-reczne/realizacja-kursu.md): not a secure context, so no position is sent.
const HOST = process.env.E2E_HOST || "localhost";
const SUPABASE_URL = HOST === "localhost" ? sb.url : sb.url.replace("127.0.0.1", HOST);

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "it-IT",
    timezoneId: "Europe/Rome",
    permissions: ["geolocation"],
    geolocation: { latitude: 45.4642, longitude: 9.19 },
  },
  projects: [
    // The carrier's job screen on phones (one job per project, scripts/seed-e2e-jobs.mjs).
    { name: "iphone", testMatch: /corsa-padroncino\.spec\.ts$/, use: { ...devices["iPhone 13"] } }, // WebKit (Safari engine)
    { name: "android", testMatch: /corsa-padroncino\.spec\.ts$/, use: { ...devices["Pixel 7"] } }, // Chromium
    // The admin panel on a desktop browser, on the demo seed's jobs (runs once: it changes them).
    { name: "desktop", testMatch: /admin-.*\.spec\.ts$/, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npx next build && npx next start -p ${PORT}${HOST === "localhost" ? "" : " -H 0.0.0.0"}`,
    url: `http://localhost:${PORT}/accedi`,
    timeout: 400_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      NEXT_DIST_DIR: ".next-e2e",
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: sb.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: sb.serviceKey,
      NEXT_PUBLIC_APP_URL: `http://${HOST}:${PORT}`,
      EMAIL_TRANSPORT: "outbox",
    },
  },
});
