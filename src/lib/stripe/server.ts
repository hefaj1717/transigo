import "server-only";
import Stripe from "stripe";
import { assertTestSecretKey, assertWebhookSecret } from "./keys";

// Stripe client for the server only (the secret key never reaches the browser).

let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (!client) {
    client = new Stripe(assertTestSecretKey(process.env.STRIPE_SECRET_KEY), {
      maxNetworkRetries: 2,
      appInfo: { name: "Transigo" },
    });
  }
  return client;
}

export function getWebhookSecret(): string {
  return assertWebhookSecret(process.env.STRIPE_WEBHOOK_SECRET);
}
