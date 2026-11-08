import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/notifications/email";
import { renderOrderPaidEmail } from "@/lib/notifications/templates/order-paid";
import { getStripe, getWebhookSecret } from "@/lib/stripe/server";
import { getAppUrl } from "@/lib/supabase/env";
import { buildCheckoutSessionParams } from "./checkout-params";
import { handlePaidSession, type ConfirmResult, type WebhookDeps } from "./webhook";

// Server side of the customer payment (Stage 3). `db` is always the service-role client; every function that
// acts for a customer takes the customer id from the verified session (Server Action) and checks ownership.

type OrderForPayment = {
  id: string;
  order_number: string;
  customer_id: string;
  status: string;
  payment_due_at: string;
  order_charges: { total_cents: number } | null;
  order_legs: { leg_index: number; pickup_city: string; delivery_city: string }[];
};

async function loadOrder(db: SupabaseClient, orderId: string): Promise<OrderForPayment | null> {
  const { data, error } = await db
    .from("orders")
    .select("id, order_number, customer_id, status, payment_due_at, order_charges(total_cents), order_legs(leg_index, pickup_city, delivery_city)")
    .eq("id", orderId)
    .maybeSingle<OrderForPayment>();
  if (error) throw new Error(`load order: ${error.message}`);
  return data;
}

async function openPayment(db: SupabaseClient, orderId: string) {
  const { data, error } = await db.from("payments").select("id, stripe_checkout_session_id").eq("order_id", orderId).eq("status", "pending").maybeSingle();
  if (error) throw new Error(`load payment: ${error.message}`);
  return data as { id: string; stripe_checkout_session_id: string } | null;
}

export type CheckoutStart =
  | { kind: "redirect"; url: string }
  | { kind: "processing" } // the session is complete: waiting for the webhook
  | { kind: "not_payable"; message: string };

const NOT_YOURS = "Ordine non trovato.";
const GENERIC = "Non è stato possibile avviare il pagamento. Riprova tra qualche minuto.";

/**
 * "Paga ora" and the first redirect after "Conferma prenotazione". One open Checkout session per order:
 * an open session is reused (same URL); a new one is created only when there is none (D88, D89).
 */
export async function startCheckout(db: SupabaseClient, customer: { id: string; email: string }, orderId: string, now = new Date()): Promise<CheckoutStart> {
  const stripe = getStripe();
  const order = await loadOrder(db, orderId);
  if (!order || order.customer_id !== customer.id) return { kind: "not_payable", message: NOT_YOURS };
  if (order.status !== "pending_payment") return { kind: "not_payable", message: "Questo ordine non è in attesa di pagamento." };
  if (now >= new Date(order.payment_due_at)) return { kind: "not_payable", message: "Il tempo per il pagamento è scaduto. Prenota di nuovo per ricevere un nuovo preventivo." };
  if (!order.order_charges) throw new Error("order without charges");

  const open = await openPayment(db, orderId);
  if (open) {
    const session = await stripe.checkout.sessions.retrieve(open.stripe_checkout_session_id);
    if (session.status === "open" && session.url) return { kind: "redirect", url: session.url };
    if (session.status === "complete") return { kind: "processing" };
    await db.rpc("expire_order_payment", { p_session_id: session.id }); // expired in Stripe, webhook not here yet
  }

  const leg0 = order.order_legs.find((l) => l.leg_index === 0);
  const last = order.order_legs.reduce((a, b) => (b.leg_index > a.leg_index ? b : a), order.order_legs[0]);
  const params = buildCheckoutSessionParams(
    {
      id: order.id,
      orderNumber: order.order_number,
      totalCents: order.order_charges.total_cents,
      pickupCity: leg0?.pickup_city ?? "",
      deliveryCity: last?.delivery_city ?? "",
      customerEmail: customer.email,
      paymentDueAt: new Date(order.payment_due_at),
    },
    getAppUrl(),
    now,
  );
  const { count } = await db.from("payments").select("id", { count: "exact", head: true }).eq("order_id", orderId);
  const session = await stripe.checkout.sessions.create(params, { idempotencyKey: `checkout:${orderId}:${count ?? 0}` });

  const { error } = await db.rpc("start_order_payment", {
    p_order_id: orderId,
    p_session_id: session.id,
    p_amount_cents: order.order_charges.total_cents,
    p_expires_at: new Date((session.expires_at ?? 0) * 1000).toISOString(),
  });
  if (error) {
    // Another tab opened a session at the same time, or the deadline passed: close ours so it cannot be paid.
    await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
    const other = await openPayment(db, orderId);
    if (other) return startCheckout(db, customer, orderId, now);
    console.error("[payments] start_order_payment:", { code: error.code, message: error.message });
    return { kind: "not_payable", message: GENERIC };
  }
  if (!session.url) return { kind: "not_payable", message: GENERIC };
  return { kind: "redirect", url: session.url };
}

export type CancelResult = { ok: true } | { ok: false; message: string };

/** D92: the customer cancels an unpaid order. The open session is closed in Stripe first, so it cannot be paid. */
export async function cancelUnpaidOrder(db: SupabaseClient, customerId: string, orderId: string): Promise<CancelResult> {
  const order = await loadOrder(db, orderId);
  if (!order || order.customer_id !== customerId) return { ok: false, message: NOT_YOURS };
  if (order.status !== "pending_payment") return { ok: false, message: "Questo ordine non può più essere annullato qui." };

  const open = await openPayment(db, orderId);
  if (open) {
    try {
      await getStripe().checkout.sessions.expire(open.stripe_checkout_session_id);
    } catch {
      // Already complete (paid a moment ago) or already expired: ask Stripe which one.
      const s = await getStripe().checkout.sessions.retrieve(open.stripe_checkout_session_id);
      if (s.status === "complete") return { ok: false, message: "Il pagamento è già in corso di verifica: l'ordine non può essere annullato qui." };
    }
    await db.rpc("expire_order_payment", { p_session_id: open.stripe_checkout_session_id });
  }
  const { data, error } = await db.rpc("expire_order", {
    p_order_id: orderId,
    p_source: "customer_app",
    p_changed_by: customerId,
    p_note: "Annullato dal cliente prima del pagamento",
    p_force: true,
  });
  if (error || !data) return { ok: false, message: "Non è stato possibile annullare l'ordine. Riprova." };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Webhook dependencies
// ---------------------------------------------------------------------------

export function webhookDeps(db: SupabaseClient): WebhookDeps {
  const stripe = getStripe();
  const secret = getWebhookSecret();
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
  return {
    constructEvent: (raw, sig) => stripe.webhooks.constructEvent(raw, sig, secret),
    events: {
      async begin(event: Stripe.Event) {
        const { data, error } = await db
          .from("stripe_events")
          .upsert(
            { event_id: event.id, type: event.type, livemode: event.livemode, account: event.account ?? null },
            { onConflict: "event_id", ignoreDuplicates: true },
          )
          .select("event_id");
        if (error) throw new Error(`stripe_events: ${error.message}`);
        if (data?.length) return "new";
        const { data: row } = await db.from("stripe_events").select("processed_at, attempts").eq("event_id", event.id).single();
        if (row?.processed_at) return "done";
        await db.from("stripe_events").update({ attempts: (row?.attempts ?? 1) + 1 }).eq("event_id", event.id);
        return "retry";
      },
      async finish(eventId, note) {
        await db.from("stripe_events").update({ processed_at: new Date().toISOString(), error: note?.startsWith("ignored") || note?.startsWith("waiting") ? note : null }).eq("event_id", eventId);
      },
      async fail(eventId, error) {
        await db.from("stripe_events").update({ error: error.slice(0, 2000) }).eq("event_id", eventId);
      },
    },
    async retrievePaymentIntent(id) {
      const pi = await stripe.paymentIntents.retrieve(id);
      const charge = typeof pi.latest_charge === "string" ? pi.latest_charge : (pi.latest_charge?.id ?? null);
      return { id: pi.id, status: pi.status, amount_received: pi.amount_received, currency: pi.currency, latest_charge: charge };
    },
    confirmPayment: (a) =>
      rpc<ConfirmResult>("confirm_order_payment", {
        p_session_id: a.sessionId,
        p_payment_intent_id: a.paymentIntentId,
        p_charge_id: a.chargeId,
        p_amount_cents: a.amountCents,
        p_currency: a.currency,
      }),
    expirePayment: (sessionId) => rpc<string | null>("expire_order_payment", { p_session_id: sessionId }),
    expireOrder: (orderId) => rpc<boolean>("expire_order", { p_order_id: orderId, p_source: "stripe_webhook" }),
    failPayment: (sessionId, message) => rpc<string | null>("fail_order_payment", { p_session_id: sessionId, p_message: message }),
    onPaid: (orderId) => sendOrderPaidEmail(db, orderId),
    log: (message, data) => console.warn(`[stripe] ${message}`, data ?? {}),
  };
}

/** Confirmation e-mail after payment (D93). Idempotent: one e-mail per order (email_outbox unique key). */
export async function sendOrderPaidEmail(db: SupabaseClient, orderId: string): Promise<void> {
  const { data: o, error } = await db
    .from("orders")
    .select("id, order_number, customer_id, order_charges(total_cents, customer_type), order_legs(leg_index, pickup_city, delivery_city, pickup_window_start, pickup_window_end)")
    .eq("id", orderId)
    .single();
  if (error || !o) throw new Error(`order for e-mail: ${error?.message ?? "not found"}`);
  const { data: profile } = await db.from("profiles").select("email, first_name").eq("id", o.customer_id).single();
  if (!profile?.email) throw new Error("customer e-mail not found");

  const legs = [...(o.order_legs as { leg_index: number; pickup_city: string; delivery_city: string; pickup_window_start: string; pickup_window_end: string }[])].sort((a, b) => a.leg_index - b.leg_index);
  const charges = o.order_charges as unknown as { total_cents: number; customer_type: "private" | "business" };
  const rendered = renderOrderPaidEmail({
    firstName: profile.first_name,
    orderNumber: o.order_number,
    pickupCity: legs[0].pickup_city,
    deliveryCity: legs[legs.length - 1].delivery_city,
    pickupWindowStart: new Date(legs[0].pickup_window_start),
    pickupWindowEnd: new Date(legs[0].pickup_window_end),
    totalCents: charges.total_cents,
    customerType: charges.customer_type,
    orderUrl: `${getAppUrl()}/cliente/ordini/${o.id}`,
  });
  await sendEmail(db, { ...rendered, templateCode: "order_paid", to: profile.email, recipientId: o.customer_id, orderId: o.id });
}

// ---------------------------------------------------------------------------
// Periodic job (safety net for missed webhooks, D91)
// ---------------------------------------------------------------------------

export type ReconcileReport = { checked: number; paid: number; review: number; expired: number; stillOpen: number; errors: number };

/**
 * For overdue unpaid orders with an open session: asks Stripe. A complete + paid session is processed like the
 * webhook; an expired one expires the order. Then expires overdue orders without any open session.
 */
export async function reconcileOverdueOrders(db: SupabaseClient, now = new Date()): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, paid: 0, review: 0, expired: 0, stillOpen: 0, errors: 0 };
  const deps = webhookDeps(db);
  const cutoff = new Date(now.getTime() - 2 * 60_000).toISOString();
  const { data: rows, error } = await db
    .from("payments")
    .select("stripe_checkout_session_id, order_id, orders!inner(status, payment_due_at)")
    .eq("status", "pending")
    .eq("orders.status", "pending_payment")
    .lte("orders.payment_due_at", cutoff)
    .limit(200);
  if (error) throw new Error(`reconcile: ${error.message}`);

  for (const row of rows ?? []) {
    report.checked++;
    try {
      const session = await getStripe().checkout.sessions.retrieve(row.stripe_checkout_session_id);
      if (session.status === "complete" && session.payment_status === "paid") {
        const result = await handlePaidSession(session, deps);
        if (result === "paid" || result === "already_processed") report.paid++;
        else report.review++;
      } else if (session.status === "expired") {
        await deps.expirePayment(session.id);
        const { data: expired } = await db.rpc("expire_order", { p_order_id: row.order_id, p_source: "system_job" });
        if (expired) report.expired++;
      } else {
        report.stillOpen++;
      }
    } catch (e) {
      report.errors++;
      console.error("[payments] reconcile:", { orderId: row.order_id, error: e instanceof Error ? e.message : e });
    }
  }
  const { data: n, error: expError } = await db.rpc("expire_unpaid_orders");
  if (expError) throw new Error(`expire_unpaid_orders: ${expError.message}`);
  report.expired += (n as number) ?? 0;
  return report;
}
