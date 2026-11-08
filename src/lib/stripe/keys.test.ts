import { describe, expect, it } from "vitest";
import { assertTestSecretKey, assertWebhookSecret, stripeDashboardPaymentUrl } from "./keys";

describe("Stripe keys: test mode only", () => {
  it("accepts test secret and restricted keys", () => {
    expect(assertTestSecretKey("sk_test_abc123")).toBe("sk_test_abc123");
    expect(assertTestSecretKey("rk_test_abc123")).toBe("rk_test_abc123");
  });
  it("refuses live keys, publishable keys and missing keys without echoing them", () => {
    for (const key of ["sk_live_abc123", "rk_live_abc123", "pk_test_abc123", "", undefined]) {
      expect(() => assertTestSecretKey(key)).toThrow();
    }
    try {
      assertTestSecretKey("sk_live_SECRETVALUE");
    } catch (e) {
      expect(String(e)).not.toContain("SECRETVALUE");
    }
  });
  it("webhook secret must be whsec_…", () => {
    expect(assertWebhookSecret("whsec_x")).toBe("whsec_x");
    expect(() => assertWebhookSecret("sk_test_x")).toThrow();
    expect(() => assertWebhookSecret(undefined)).toThrow();
  });
  it("dashboard link points to test mode", () => {
    expect(stripeDashboardPaymentUrl("pi_123")).toBe("https://dashboard.stripe.com/test/payments/pi_123");
  });
});
