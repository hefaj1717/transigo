import { describe, expect, it } from "vitest";
import { buildCheckoutSessionParams, MAX_SESSION_MS, MIN_SESSION_MS, sessionExpiresAt, type CheckoutOrder } from "./checkout-params";
import { isAuthorizedCron } from "./cron-auth";

const now = new Date("2026-11-09T10:00:00Z");
const order: CheckoutOrder = {
  id: "11111111-1111-4111-8111-111111111111",
  orderNumber: "TG-2026-000042",
  totalCents: 19_520,
  summary: { service: "transport", pickupCity: "Milano", deliveryCity: "Torino", window: { start: new Date("2026-11-10T09:00:00Z"), end: new Date("2026-11-10T11:00:00Z") } },
  customerEmail: "cliente@example.com",
  paymentDueAt: new Date("2026-11-09T11:00:00Z"),
};

describe("sessionExpiresAt", () => {
  it("ends at the order payment deadline", () => {
    expect(sessionExpiresAt(new Date("2026-11-09T11:00:00Z"), now).toISOString()).toBe("2026-11-09T11:00:00.000Z");
  });
  it("is never shorter than the Stripe minimum (30 min + margin)", () => {
    expect(sessionExpiresAt(new Date("2026-11-09T10:05:00Z"), now).getTime()).toBe(now.getTime() + MIN_SESSION_MS);
  });
  it("is never longer than the Stripe maximum (24 h − margin)", () => {
    expect(sessionExpiresAt(new Date("2026-11-12T10:00:00Z"), now).getTime()).toBe(now.getTime() + MAX_SESSION_MS);
  });
});

describe("buildCheckoutSessionParams", () => {
  const p = buildCheckoutSessionParams(order, "https://app.example", now);

  it("charges the order total in EUR, one line, gross", () => {
    expect(p.mode).toBe("payment");
    expect(p.line_items).toEqual([
      { quantity: 1, price_data: { currency: "eur", unit_amount: 19_520, product_data: { name: "Ordine TG-2026-000042 – Trasporto e servizi", description: "Milano → Torino" } } },
    ]);
    expect(p.adaptive_pricing).toEqual({ enabled: false });
  });

  it("Facchinaggio and Deposito: own line name and description, no route (D151)", () => {
    const porters = buildCheckoutSessionParams({ ...order, summary: { service: "porters", city: "Bologna", window: { start: now, end: now }, persons: 2, hours: 3 } }, "https://app.example", now);
    expect(porters.line_items?.[0].price_data?.product_data).toEqual({ name: "Ordine TG-2026-000042 – Facchinaggio", description: "Facchinaggio a Bologna" });
    const storage = buildCheckoutSessionParams({ ...order, summary: { service: "storage", startDate: "2026-12-01", endDate: "2026-12-31", unitLabel: "Box M" } }, "https://app.example", now);
    expect(storage.line_items?.[0].price_data?.product_data).toEqual({ name: "Ordine TG-2026-000042 – Deposito", description: "Deposito Box M dal 01/12/2026 al 31/12/2026" });
  });

  it("carries order_id and order_number in session and PaymentIntent metadata", () => {
    const metadata = { order_id: order.id, order_number: "TG-2026-000042" };
    expect(p.metadata).toEqual(metadata);
    expect(p.client_reference_id).toBe(order.id);
    expect(p.payment_intent_data?.metadata).toEqual(metadata);
  });

  it("transfer_group = order number (separate charges and transfers, D90)", () => {
    expect(p.payment_intent_data?.transfer_group).toBe("TG-2026-000042");
  });

  it("expires at the payment deadline, Italian, return URLs to the order page", () => {
    expect(p.expires_at).toBe(Math.floor(new Date("2026-11-09T11:00:00Z").getTime() / 1000));
    expect(p.locale).toBe("it");
    expect(p.customer_email).toBe("cliente@example.com");
    expect(p.success_url).toBe(`https://app.example/cliente/ordini/${order.id}?pagamento=ok`);
    expect(p.cancel_url).toBe(`https://app.example/cliente/ordini/${order.id}?pagamento=annullato`);
  });

  it("refuses a non-integer or non-positive total", () => {
    expect(() => buildCheckoutSessionParams({ ...order, totalCents: 0 }, "https://x", now)).toThrow();
    expect(() => buildCheckoutSessionParams({ ...order, totalCents: 10.5 }, "https://x", now)).toThrow();
  });
});

describe("isAuthorizedCron", () => {
  const secret = "a".repeat(64);
  it("accepts the exact bearer secret", () => expect(isAuthorizedCron(`Bearer ${secret}`, secret)).toBe(true));
  it("rejects a wrong, missing or short secret", () => {
    expect(isAuthorizedCron(`Bearer ${"b".repeat(64)}`, secret)).toBe(false);
    expect(isAuthorizedCron(null, secret)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${secret}`, undefined)).toBe(false);
    expect(isAuthorizedCron("Bearer short", "short")).toBe(false);
  });
});
