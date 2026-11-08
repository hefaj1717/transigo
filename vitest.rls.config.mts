import { defineConfig } from "vitest/config";

// Security (RLS) tests run against the linked Supabase cloud project.
// They create throwaway users with the service role key from .env.local and delete them afterwards.
// Run with: npm run test:rls
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/rls/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
