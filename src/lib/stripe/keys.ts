// Stripe key checks (pure, tested). Stripe runs in TEST MODE ONLY until the owner says otherwise (CLAUDE.md).

/** Throws unless `key` is a Stripe test secret key (sk_test_…) or restricted test key (rk_test_…). Never echoes the key. */
export function assertTestSecretKey(key: string | undefined): string {
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY (set it in .env.local)");
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) {
    throw new Error("STRIPE_SECRET_KEY must be a Stripe TEST key (sk_test_… or rk_test_…). Live keys are not allowed yet.");
  }
  return key;
}

/** Throws unless `secret` looks like a webhook signing secret (whsec_…). */
export function assertWebhookSecret(secret: string | undefined): string {
  if (!secret) throw new Error("Missing STRIPE_WEBHOOK_SECRET (set it in .env.local; `stripe listen` prints it)");
  if (!secret.startsWith("whsec_")) throw new Error("STRIPE_WEBHOOK_SECRET must start with whsec_");
  return secret;
}

/** Link to a payment in the Stripe Dashboard (test mode). */
export function stripeDashboardPaymentUrl(paymentIntentId: string): string {
  return `https://dashboard.stripe.com/test/payments/${encodeURIComponent(paymentIntentId)}`;
}
