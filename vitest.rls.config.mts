import { defineConfig } from "vitest/config";

// Security (RLS) tests run ONLY against this repo's local Supabase stack (D64), never staging/production.
// global-setup.ts reads the local URL and keys from `supabase status`, refuses any other target and
// resets the local database before the run.
// Run with: npm run db:local:start (once, Docker required), then npm run test:rls
export default defineConfig({
  // "server-only" throws outside React Server Components; tests import server modules directly.
  resolve: { tsconfigPaths: true, alias: { "server-only": new URL("./tests/stubs/server-only.ts", import.meta.url).pathname } },
  test: {
    environment: "node",
    include: ["tests/rls/**/*.test.ts"],
    exclude: ["tests/**/*.unit.test.ts"],
    globalSetup: ["tests/rls/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
