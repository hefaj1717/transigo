import type Stripe from "stripe";

// Stripe Checkout session parameters (pure, tested). The amount always comes from order_charges.total_cents
// read on the server (D89) — never from the browser.

/** Stripe accepts expires_at between 30 min and 24 h after creation; we keep 1 min of margin on both ends. */
export const MIN_SESSION_MS = 31 * 60_000;
export const MAX_SESSION_MS = 23 * 3600_000 + 59 * 60_000;

/**
 * The session lives until the order's payment deadline (D88), but at least the Stripe minimum. The order is
 * not expired while a session is open (expire_order), so a session ending a few minutes after the deadline is fine.
 */
export function sessionExpiresAt(paymentDueAt: Date, now: Date): Date {
  const min = now.getTime() + MIN_SESSION_MS;
  const max = now.getTime() + MAX_SESSION_MS;
  return new Date(Math.min(max, Math.max(min, paymentDueAt.getTime())));
}

export type CheckoutOrder = {
  id: string;
  orderNumber: string;
  totalCents: number;
  pickupCity: string;
  deliveryCity: string;
  customerEmail: string;
  paymentDueAt: Date;
};

export function buildCheckoutSessionParams(order: CheckoutOrder, appUrl: string, now: Date): Stripe.Checkout.SessionCreateParams {
  if (!Number.isInteger(order.totalCents) || order.totalCents <= 0) throw new Error("Order total must be a positive integer (cents)");
  const metadata = { order_id: order.id, order_number: order.orderNumber };
  const orderUrl = `${appUrl}/cliente/ordini/${order.id}`;
  return {
    mode: "payment",
    // D95: payment methods are chosen in the Stripe Dashboard (Settings → Payment methods): cards, with
    // Apple Pay / Google Pay. This API version has no payment_method_types; asynchronous methods are still
    // handled by the webhook (async_payment_succeeded / failed) in case they get enabled.
    adaptive_pricing: { enabled: false }, // always charge EUR: no conversion to the customer's local currency
    locale: "it",
    customer_email: order.customerEmail,
    client_reference_id: order.id,
    metadata,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: order.totalCents, // gross (VAT included); the e-invoice comes from SDI (Stage 6)
          product_data: {
            name: `Ordine ${order.orderNumber} – Trasporto e servizi`,
            description: `${order.pickupCity} → ${order.deliveryCity}`,
          },
        },
      },
    ],
    payment_intent_data: {
      metadata,
      transfer_group: order.orderNumber, // D90: separate charges and transfers (carrier payout in Stage 6)
      description: `Transigo ${order.orderNumber}`,
    },
    expires_at: Math.floor(sessionExpiresAt(order.paymentDueAt, now).getTime() / 1000),
    success_url: `${orderUrl}?pagamento=ok`,
    cancel_url: `${orderUrl}?pagamento=annullato`,
  };
}
