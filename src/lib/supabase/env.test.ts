import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrlOrNull, getAppUrl } from "./env";

afterEach(() => vi.unstubAllEnvs());

function setEnv(appUrl: string | undefined, vercelHost: string | undefined) {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", appUrl ?? "");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", vercelHost ?? "");
}

describe("appUrlOrNull / getAppUrl", () => {
  it("prefers NEXT_PUBLIC_APP_URL, without trailing slashes", () => {
    setEnv("http://localhost:3000/", "transigo-transi-go.vercel.app");
    expect(getAppUrl()).toBe("http://localhost:3000");
  });

  it("falls back to the Vercel production domain over https", () => {
    setEnv(undefined, "transigo-transi-go.vercel.app");
    expect(getAppUrl()).toBe("https://transigo-transi-go.vercel.app");
  });

  it("accepts a Vercel value that already has a scheme or a trailing slash", () => {
    setEnv("  ", "https://transigo-transi-go.vercel.app/");
    expect(appUrlOrNull()).toBe("https://transigo-transi-go.vercel.app");
  });

  it("is null / throws when neither is set", () => {
    setEnv(undefined, undefined);
    expect(appUrlOrNull()).toBeNull();
    expect(() => getAppUrl()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });
});
