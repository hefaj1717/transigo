import { defineConfig } from "vitest/config";

export default defineConfig({
  // "server-only" throws outside React Server Components; tests import server modules directly.
  resolve: { tsconfigPaths: true, alias: { "server-only": new URL("./tests/stubs/server-only.ts", import.meta.url).pathname } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.unit.test.ts"],
  },
});
