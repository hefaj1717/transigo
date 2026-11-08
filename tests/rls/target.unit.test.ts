import { describe, expect, it } from "vitest";
import { assertLocalTarget, LOCAL_API_URL } from "./target";

describe("RLS test target guard (D64)", () => {
  it("accepts only the local TransiGo stack", () => {
    expect(assertLocalTarget("http://127.0.0.1:55321")).toBe(LOCAL_API_URL);
    expect(assertLocalTarget("http://localhost:55321/")).toBe(LOCAL_API_URL);
  });
  it.each([
    "https://bacabuzzevwwdxrswbnc.supabase.co", // staging
    "https://example.supabase.co",
    "http://127.0.0.1:54321", // another local Supabase project (default port)
    "https://127.0.0.1:55321",
    "http://10.0.0.5:55321",
    "http://127.0.0.1:55321/rest/v1",
    "",
    undefined,
  ])("rejects %s", (url) => {
    expect(() => assertLocalTarget(url)).toThrow(/RLS tests/);
  });
});
