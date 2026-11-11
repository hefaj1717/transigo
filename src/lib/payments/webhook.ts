import type Stripe from "stripe";
import { refundStatusFromStripe, type RefundStatus } from "@/lib/orders/cancellation";

// Stripe webhook processing (D89–D91). Pure orchestration: Stripe and the database come in as dependencies,
// so every path is unit-tested (src/lib/payments/webhook.test.ts); the real ones are in ./server.ts.
//
//   1. signature verified (constructEvent) — a bad or missing signature → 400, nothing stored;
//   2. idempotency: the event id is stored once (stripe_events); an event already processed → 200, no action;
//      an event that failed before is processed again (Stripe retries on 5xx);
//   3. the order becomes "paid" only through confirm_order_payment(), and only when the amount and currency
//      received match the order (otherwise payment_review — checked again in the database).

export type ConfirmResult = {
  result: "paid" | "already_processed" | "review";
  order_id: string;
  order_number: string;
  status: string;
  reason?: string;
};

export type PaymentIntentView = { id: string; status: string; amount_received: number; currency: string; latest_charge: string | null };

export type WebhookDeps = {
  /** Verifies the signature and parses the event (stripe.webhooks.constructEvent); throws on a bad signature. */
  constructEvent: (rawBody: string, signature: string) => Stripe.Event;
  events: {
    /** Stores the event id; "done" when it was already processed, "new"/"retry" otherwise. */
    begin: (event: Stripe.Event) => Promise<"new" | "retry" | "done">;
    finish: (eventId: string, note?: string) => Promise<void>;
    fail: (eventId: string, error: string) => Promise<void>;
  };
  retrievePaymentIntent: (id: string) => Promise<PaymentIntentView>;
  confirmPayment: (args: { sessionId: string; paymentIntentId: string; chargeId: string | null; amountCents: number; currency: string }) => Promise<ConfirmResult>;
  expirePayment: (sessionId: string) => Promise<string | null>;
  expireOrder: (orderId: string) => Promise<boolean>;
  failPayment: (sessionId: string, message: string) => Promise<string | null>;
  /** After a confirmed payment: confirmation e-mail (idempotent per order). Errors are logged, never fail the webhook. */
  onPaid: (orderId: string) => Promise<void>;
  /** The outcome of a refund we created (record_refund_result; repeated calls are no-ops). */
  recordRefund: (refundId: string, stripeRefundId: string, status: RefundStatus) => Promise<boolean>;
  log: (message: string, data?: Record<string, unknown>) => void;
};

export type WebhookResponse = { status: number; body: Record<string, unknown> };

export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  // Refunds of customer cancellations (D137) that Stripe completes or fails after the Refund call.
  "refund.updated",
  "refund.failed",
] as const;

export async function processStripeWebhook(rawBody: string, signature: string | null, deps: WebhookDeps): Promise<WebhookResponse> {
  if (!signature) return { status: 400, body: { error: "missing signature" } };
  let event: Stripe.Event;
  try {
    event = deps.constructEvent(rawBody, signature);
  } catch {
    return { status: 400, body: { error: "invalid signature" } };
  }

  const state = await deps.events.begin(event);
  if (state === "done") return { status: 200, body: { received: true, duplicate: true } };

  try {
    const note = await handleEvent(event, deps);
    await deps.events.finish(event.id, note);
    return { status: 200, body: { received: true } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.log("stripe webhook failed", { eventId: event.id, type: event.type, error: message });
    await deps.events.fail(event.id, message);
    return { status: 500, body: { error: "processing failed" } }; // Stripe retries
  }
}

/** Handles one verified event. Returns a short note for stripe_events (e.g. why it was ignored). */
export async function handleEvent(event: Stripe.Event, deps: WebhookDeps): Promise<string | undefined> {
  if (event.livemode) return "ignored: live mode event (test mode only)";

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      if (!isOurSession(session)) return "ignored: not a Transigo order session";
      if (session.payment_status !== "paid") return `waiting: payment_status ${session.payment_status}`;
      return handlePaidSession(session, deps);
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object;
      if (!isOurSession(session)) return "ignored: not a Transigo order session";
      await deps.failPayment(session.id, "Pagamento non riuscito");
      return "payment failed";
    }
    case "checkout.session.expired": {
      const session = event.data.object;
      if (!isOurSession(session)) return "ignored: not a Transigo order session";
      const orderId = await deps.expirePayment(session.id);
      if (!orderId) return "ignored: unknown session";
      const expired = await deps.expireOrder(orderId);
      return expired ? "order expired" : "session expired, order kept";
    }
    case "refund.updated":
    case "refund.failed": {
      const refund = event.data.object;
      const refundId = refund.metadata?.refund_id;
      if (!refundId) return "ignored: not a Transigo refund";
      const changed = await deps.recordRefund(refundId, refund.id, refundStatusFromStripe(refund.status));
      return changed ? `refund ${refund.status}` : "refund unchanged";
    }
    default:
      return `ignored: ${event.type}`;
  }
}

function isOurSession(session: Stripe.Checkout.Session): boolean {
  return session.mode === "payment" && typeof session.metadata?.order_id === "string" && session.metadata.order_id.length > 0;
}

/**
 * A paid session: amount and currency are taken from the PaymentIntent (the money actually received).
 * The database compares them with the payment row and the order total (confirm_order_payment).
 */
export async function handlePaidSession(session: Stripe.Checkout.Session, deps: Pick<WebhookDeps, "retrievePaymentIntent" | "confirmPayment" | "onPaid" | "log">): Promise<string> {
  const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!piId) throw new Error("paid session without payment_intent");
  const pi = await deps.retrievePaymentIntent(piId);
  if (pi.status !== "succeeded") throw new Error(`payment intent status ${pi.status}`); // retried later by Stripe

  if (session.amount_total !== pi.amount_received) {
    deps.log("session total differs from amount received", { sessionId: session.id, sessionTotal: session.amount_total, received: pi.amount_received });
  }
  // The money actually received decides; the database compares it with the order total.
  const result = await deps.confirmPayment({
    sessionId: session.id,
    paymentIntentId: pi.id,
    chargeId: pi.latest_charge,
    amountCents: pi.amount_received,
    currency: pi.currency,
  });

  if (result.result === "review") {
    deps.log("payment needs review", { orderNumber: result.order_number, reason: result.reason });
    return `review: ${result.reason ?? "unknown"}`;
  }
  if (result.status === "paid" || result.result === "paid") {
    // Also on "already_processed": a previous attempt may have failed after confirming; the outbox dedupes.
    try {
      await deps.onPaid(result.order_id);
    } catch (e) {
      deps.log("order paid e-mail failed", { orderNumber: result.order_number, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result.result;
}
