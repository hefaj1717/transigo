import { NextResponse } from "next/server";
import { processStripeWebhook } from "@/lib/payments/webhook";
import { webhookDeps } from "@/lib/payments/server";
import { createServiceClient } from "@/lib/supabase/service";

// Stripe webhook (D89). The proxy skips /api/webhooks (no user session). The raw body is needed for the
// signature check, so it is read as text before anything else. Status "paid" is set only here.
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  const result = await processStripeWebhook(rawBody, signature, webhookDeps(createServiceClient()));
  return NextResponse.json(result.body, { status: result.status });
}
