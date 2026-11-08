import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processStripeWebhook, type ConfirmResult, type WebhookDeps } from "./webhook";

// Every webhook path with a real signature check (stripe.webhooks, offline) and fake database/Stripe calls.

const SECRET = "whsec_test_secret_for_unit_tests";
const stripe = new Stripe("sk_test_unit", {});
const ORDER_ID = "11111111-1111-4111-8111-111111111111";

function sign(payload: string, secret = SECRET) {
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

function sessionEvent(type: string, session: Partial<Stripe.Checkout.Session> = {}, extra: Partial<Stripe.Event> = {}) {
  return JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    livemode: false,
    created: 1,
    api_version: "2026-09-30.endive",
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: 12_200,
        currency: "eur",
        payment_intent: "pi_1",
        metadata: { order_id: ORDER_ID, order_number: "TG-2026-000001" },
        ...session,
      },
    },
    ...extra,
  });
}

type Fake = WebhookDeps & {
  processed: Set<string>;
  seen: Set<string>;
  calls: Record<string, unknown[][]>;
};

function fakeDeps(over: Partial<WebhookDeps> = {}, confirm: ConfirmResult = { result: "paid", order_id: ORDER_ID, order_number: "TG-2026-000001", status: "paid" }): Fake {
  const processed = new Set<string>();
  const seen = new Set<string>();
  const calls: Record<string, unknown[][]> = {};
  const spy = <A extends unknown[], R>(name: string, impl: (...a: A) => R) =>
    vi.fn((...a: A) => {
      (calls[name] ??= []).push(a);
      return impl(...a);
    });
  const deps: Fake = {
    processed,
    seen,
    calls,
    constructEvent: (raw, sig) => stripe.webhooks.constructEvent(raw, sig, SECRET),
    events: {
      begin: spy("begin", async (e: Stripe.Event) => {
        if (processed.has(e.id)) return "done" as const;
        if (seen.has(e.id)) return "retry" as const;
        seen.add(e.id);
        return "new" as const;
      }),
      finish: spy("finish", async (id: string) => {
        processed.add(id);
      }),
      fail: spy("fail", async () => undefined),
    },
    retrievePaymentIntent: spy("retrievePaymentIntent", async (id: string) => ({ id, status: "succeeded", amount_received: 12_200, currency: "eur", latest_charge: "ch_1" })),
    confirmPayment: spy("confirmPayment", async () => confirm),
    expirePayment: spy("expirePayment", async () => ORDER_ID),
    expireOrder: spy("expireOrder", async () => true),
    failPayment: spy("failPayment", async () => ORDER_ID),
    onPaid: spy("onPaid", async () => undefined),
    log: () => undefined,
    ...over,
  };
  return deps;
}

let deps: Fake;
beforeEach(() => {
  deps = fakeDeps();
});

describe("signature", () => {
  it("missing signature → 400, nothing stored", async () => {
    const body = sessionEvent("checkout.session.completed");
    const r = await processStripeWebhook(body, null, deps);
    expect(r.status).toBe(400);
    expect(deps.calls.begin).toBeUndefined();
  });

  it("wrong secret → 400, nothing stored or confirmed", async () => {
    const body = sessionEvent("checkout.session.completed");
    const r = await processStripeWebhook(body, sign(body, "whsec_other"), deps);
    expect(r.status).toBe(400);
    expect(deps.calls.begin).toBeUndefined();
    expect(deps.calls.confirmPayment).toBeUndefined();
  });

  it("tampered body → 400", async () => {
    const body = sessionEvent("checkout.session.completed");
    const header = sign(body);
    const tampered = body.replace("12200", "1");
    const r = await processStripeWebhook(tampered, header, deps);
    expect(r.status).toBe(400);
  });

  it("valid signature → 200", async () => {
    const body = sessionEvent("checkout.session.completed");
    const r = await processStripeWebhook(body, sign(body), deps);
    expect(r.status).toBe(200);
  });
});

describe("idempotency", () => {
  it("the same event delivered twice is processed once", async () => {
    const body = sessionEvent("checkout.session.completed");
    await processStripeWebhook(body, sign(body), deps);
    const second = await processStripeWebhook(body, sign(body), deps);
    expect(second).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(deps.calls.confirmPayment).toHaveLength(1);
    expect(deps.calls.onPaid).toHaveLength(1);
  });

  it("a failed event returns 500, is marked failed, and is processed again on retry", async () => {
    let fail = true;
    deps = fakeDeps({
      retrievePaymentIntent: async (id) => {
        if (fail) throw new Error("Stripe down");
        return { id, status: "succeeded", amount_received: 12_200, currency: "eur", latest_charge: "ch_1" };
      },
    });
    const body = sessionEvent("checkout.session.completed");
    const first = await processStripeWebhook(body, sign(body), deps);
    expect(first.status).toBe(500);
    expect(deps.calls.fail).toHaveLength(1);
    expect(deps.processed.size).toBe(0);
    fail = false;
    const retry = await processStripeWebhook(body, sign(body), deps);
    expect(retry.status).toBe(200);
    expect(deps.calls.confirmPayment).toHaveLength(1);
  });
});

describe("checkout.session.completed", () => {
  it("paid session → confirm with amounts from the PaymentIntent, then the e-mail", async () => {
    const body = sessionEvent("checkout.session.completed");
    await processStripeWebhook(body, sign(body), deps);
    expect(deps.calls.retrievePaymentIntent).toEqual([["pi_1"]]);
    expect(deps.calls.confirmPayment).toEqual([[{ sessionId: "cs_test_1", paymentIntentId: "pi_1", chargeId: "ch_1", amountCents: 12_200, currency: "eur" }]]);
    expect(deps.calls.onPaid).toEqual([[ORDER_ID]]);
  });

  it("the money received decides: a different amount goes to the database as received", async () => {
    deps = fakeDeps(
      { retrievePaymentIntent: async (id) => ({ id, status: "succeeded", amount_received: 100, currency: "eur", latest_charge: "ch_1" }) },
      { result: "review", reason: "amount_mismatch", order_id: ORDER_ID, order_number: "TG-2026-000001", status: "payment_review" },
    );
    const body = sessionEvent("checkout.session.completed");
    const r = await processStripeWebhook(body, sign(body), deps);
    expect(r.status).toBe(200);
    expect((deps.calls.confirmPayment[0][0] as { amountCents: number }).amountCents).toBe(100);
    expect(deps.calls.onPaid).toBeUndefined(); // no "paid" e-mail for a payment under review
  });

  it("review (wrong currency) → no e-mail", async () => {
    deps = fakeDeps(
      { retrievePaymentIntent: async (id) => ({ id, status: "succeeded", amount_received: 12_200, currency: "usd", latest_charge: "ch_1" }) },
      { result: "review", reason: "currency_mismatch", order_id: ORDER_ID, order_number: "TG-2026-000001", status: "payment_review" },
    );
    const body = sessionEvent("checkout.session.completed");
    await processStripeWebhook(body, sign(body), deps);
    expect((deps.calls.confirmPayment[0][0] as { currency: string }).currency).toBe("usd");
    expect(deps.calls.onPaid).toBeUndefined();
  });

  it("already processed in the database → e-mail retried (the outbox dedupes), no error", async () => {
    deps = fakeDeps({}, { result: "already_processed", order_id: ORDER_ID, order_number: "TG-2026-000001", status: "paid" });
    const body = sessionEvent("checkout.session.completed");
    const r = await processStripeWebhook(body, sign(body), deps);
    expect(r.status).toBe(200);
    expect(deps.calls.onPaid).toHaveLength(1);
  });

  it("an e-mail failure does not fail the webhook", async () => {
    deps = fakeDeps({ onPaid: async () => { throw new Error("smtp"); } });
    const body = sessionEvent("checkout.session.completed");
    const r = await processStripeWebhook(body, sign(body), deps);
    expect(r.status).toBe(200);
  });

  it("payment_status unpaid (asynchronous method) → no confirmation yet", async () => {
    const body = sessionEvent("checkout.session.completed", { payment_status: "unpaid" });
    const r = await processStripeWebhook(body, sign(body), deps);
    expect(r.status).toBe(200);
    expect(deps.calls.confirmPayment).toBeUndefined();
  });

  it("PaymentIntent not succeeded → 500 (Stripe retries), not paid", async () => {
    deps = fakeDeps({ retrievePaymentIntent: async (id) => ({ id, status: "processing", amount_received: 0, currency: "eur", latest_charge: null }) });
    const body = sessionEvent("checkout.session.completed");
    const r = await processStripeWebhook(body, sign(body), deps);
    expect(r.status).toBe(500);
    expect(deps.calls.confirmPayment).toBeUndefined();
  });

  it("a session without order metadata (not ours) is ignored", async () => {
    const body = sessionEvent("checkout.session.completed", { metadata: {} });
    const r = await processStripeWebhook(body, sign(body), deps);
    expect(r.status).toBe(200);
    expect(deps.calls.confirmPayment).toBeUndefined();
    expect(deps.processed.size).toBe(1);
  });

  it("a live-mode event is ignored (test mode only)", async () => {
    const body = sessionEvent("checkout.session.completed", {}, { livemode: true });
    const r = await processStripeWebhook(body, sign(body), deps);
    expect(r.status).toBe(200);
    expect(deps.calls.confirmPayment).toBeUndefined();
  });
});

describe("other events", () => {
  it("async_payment_succeeded → confirmed like completed", async () => {
    const body = sessionEvent("checkout.session.async_payment_succeeded");
    await processStripeWebhook(body, sign(body), deps);
    expect(deps.calls.confirmPayment).toHaveLength(1);
  });

  it("async_payment_failed → payment failed, order not touched", async () => {
    const body = sessionEvent("checkout.session.async_payment_failed", { payment_status: "unpaid" });
    await processStripeWebhook(body, sign(body), deps);
    expect(deps.calls.failPayment).toEqual([["cs_test_1", "Pagamento non riuscito"]]);
    expect(deps.calls.confirmPayment).toBeUndefined();
    expect(deps.calls.expireOrder).toBeUndefined();
  });

  it("expired → payment expired, then the order (the database checks the deadline)", async () => {
    const body = sessionEvent("checkout.session.expired", { status: "expired", payment_status: "unpaid" });
    await processStripeWebhook(body, sign(body), deps);
    expect(deps.calls.expirePayment).toEqual([["cs_test_1"]]);
    expect(deps.calls.expireOrder).toEqual([[ORDER_ID]]);
  });

  it("expired for an unknown session → order untouched", async () => {
    deps = fakeDeps({ expirePayment: async () => null });
    const body = sessionEvent("checkout.session.expired", { status: "expired" });
    await processStripeWebhook(body, sign(body), deps);
    expect(deps.calls.expireOrder).toBeUndefined();
  });

  it("unhandled event types are stored as processed with no action", async () => {
    const body = sessionEvent("payment_intent.created");
    const r = await processStripeWebhook(body, sign(body), deps);
    expect(r.status).toBe(200);
    expect(deps.processed.size).toBe(1);
    for (const k of ["confirmPayment", "expirePayment", "failPayment", "expireOrder"]) expect(deps.calls[k]).toBeUndefined();
  });
});
