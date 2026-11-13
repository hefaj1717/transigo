import { describe, expect, it } from "vitest";
import { checkoutReturnBase } from "./return-url";

const FALLBACK = "https://transigo-psi.vercel.app";

describe("checkoutReturnBase", () => {
  it("returns to the Vercel alias the customer paid from (session cookie lives there)", () => {
    expect(checkoutReturnBase({ host: "transigo-staging.vercel.app", proto: "https" }, FALLBACK)).toBe("https://transigo-staging.vercel.app");
    expect(checkoutReturnBase({ host: "transigo-psi.vercel.app", proto: "https" }, FALLBACK)).toBe(FALLBACK);
  });

  it("forces https on public hosts", () => {
    expect(checkoutReturnBase({ host: "transigo-staging.vercel.app", proto: "http" }, FALLBACK)).toBe("https://transigo-staging.vercel.app");
  });

  it("accepts the configured app domain (custom domain)", () => {
    expect(checkoutReturnBase({ host: "www.transigo.it", proto: "https" }, "https://www.transigo.it")).toBe("https://www.transigo.it");
  });

  it("keeps local dev and Wi-Fi phones on http", () => {
    expect(checkoutReturnBase({ host: "localhost:3000", proto: null }, FALLBACK)).toBe("http://localhost:3000");
    expect(checkoutReturnBase({ host: "192.168.1.20:3000", proto: "http" }, FALLBACK)).toBe("http://192.168.1.20:3000");
  });

  it("falls back for unknown or malformed hosts", () => {
    expect(checkoutReturnBase({ host: "evil.example.com", proto: "https" }, FALLBACK)).toBe(FALLBACK);
    expect(checkoutReturnBase({ host: "evil.vercel.app:444", proto: "https" }, FALLBACK)).toBe(FALLBACK);
    expect(checkoutReturnBase({ host: "a.vercel.app/x", proto: "https" }, FALLBACK)).toBe(FALLBACK);
    expect(checkoutReturnBase({ host: null, proto: null }, FALLBACK)).toBe(FALLBACK);
    expect(checkoutReturnBase({ host: "", proto: null }, FALLBACK)).toBe(FALLBACK);
  });

  it("uses the first value of a forwarded list", () => {
    expect(checkoutReturnBase({ host: "transigo-staging.vercel.app, other.vercel.app", proto: "https" }, FALLBACK)).toBe("https://transigo-staging.vercel.app");
  });
});
