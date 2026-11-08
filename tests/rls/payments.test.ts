import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";

// Stage 3 security tests: payments, refunds, stripe_events, email_outbox and the payment functions
// (D88–D95). "paid" only through confirm_order_payment (Stripe webhook); customers cannot change payment state.

const vat = () => Math.floor(Math.random() * 1e11).toString().padStart(11, "0");
const TOTAL = 12_200;

let customerA: TestUser;
let customerB: TestUser;
let carrier: TestUser;
let admin: TestUser;
let priceList: { id: string; version: number };
let vehicleTypeId: string;
const createdOrders: string[] = [];

const check = async (p: PromiseLike<{ error: unknown }>) => {
  const { error } = await p;
  if (error) throw error;
};

function payload(customerId: string, pickupStart = "2026-12-01T09:00:00Z") {
  const end = new Date(new Date(pickupStart).getTime() + 2 * 3600_000).toISOString();
  return {
    customer_id: customerId,
    vehicle_type_id: vehicleTypeId,
    goods_description: "Scatoloni",
    packing_items_count: 0,
    pickup_contact_name: "Mario Rossi",
    pickup_contact_phone: "+393331234567",
    delivery_contact_name: "Lucia Bianchi",
    delivery_contact_phone: "+393337654321",
    storage: null,
    legs: [
      {
        leg_index: 0,
        pickup_address: "Via Roma 1, 20121 Milano MI",
        pickup_lat: 45.46,
        pickup_lng: 9.19,
        pickup_city: "Milano",
        pickup_province: "MI",
        delivery_address: "Via Po 2, 10124 Torino TO",
        delivery_lat: 45.07,
        delivery_lng: 7.68,
        delivery_city: "Torino",
        delivery_province: "TO",
        distance_m: 143_122,
        pickup_date: pickupStart.slice(0, 10),
        pickup_window_start: pickupStart,
        pickup_window_end: end,
        is_urgent: false,
      },
    ],
    charges: {
      price_list_id: priceList.id,
      price_list_version: priceList.version,
      customer_type: "private",
      vat_rate_bp: 2200,
      subtotal_cents: 10_000,
      vat_cents: 2_200,
      total_cents: TOTAL,
      billing_details: { fiscal_code: "RSSMRA80A01F205X" },
      terms_accepted_at: new Date().toISOString(),
      terms_version: "2026-11-01",
      quoted_at: new Date().toISOString(),
    },
    lines: [
      { sort_order: 0, leg_index: 0, line_type: "transport", label_it: "Trasporto", quantity: 1, unit_amount_cents: 10_000, net_cents: 10_000, vat_cents: 2_200, gross_cents: TOTAL, carrier_share_group: "transport" },
    ],
    carrier_terms: [{ leg_index: 0, carrier_amount_cents: 7_000, transport_carrier_cents: 7_000 }],
  };
}

async function newOrder(customerId: string, pickupStart?: string) {
  const { data, error } = await service.rpc("create_order", { p: payload(customerId, pickupStart) });
  if (error) throw error;
  const order = data as { id: string; order_number: string };
  createdOrders.push(order.id);
  return order;
}

async function order(id: string) {
  const { data, error } = await service.from("orders").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function startPayment(orderId: string, amount = TOTAL) {
  const session = `cs_test_${randomUUID()}`;
  const { error } = await service.rpc("start_order_payment", {
    p_order_id: orderId,
    p_session_id: session,
    p_amount_cents: amount,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  if (error) throw error;
  return session;
}

const confirm = (session: string, amount = TOTAL, currency = "eur") =>
  service.rpc("confirm_order_payment", {
    p_session_id: session,
    p_payment_intent_id: `pi_${randomUUID()}`,
    p_charge_id: `ch_${randomUUID()}`,
    p_amount_cents: amount,
    p_currency: currency,
  });

/** payment_due_at is immutable, so tests that need a short deadline create an order with a close pickup. */
const soonPickup = () => {
  // pickup in 3 h 20 min → due = max(now + 30 min, min(now + 60 min, pickup − 3 h)) = now + 30 min
  const t = new Date(Date.now() + 3 * 3600_000 + 20 * 60_000);
  t.setUTCSeconds(0, 0);
  return t.toISOString();
};

beforeAll(async () => {
  [customerA, customerB, carrier, admin] = await Promise.all([createUser({}), createUser({}), createUser({ role: "padroncino" }), createUser({})]);
  await check(service.from("customers").insert([customerA, customerB].map((u) => ({ profile_id: u.id, customer_type: "private" }))));
  await check(service.from("carriers").insert({ profile_id: carrier.id, company_name: "Trasporti Test", vat_number: vat(), status: "active" }));
  await check(service.from("profiles").update({ role: "admin" }).eq("id", admin.id));

  const { data: list, error: listError } = await service.from("price_lists").select("id, version").eq("status", "active").single();
  if (listError) throw listError;
  priceList = list;
  const { data: vt, error: vtError } = await service.from("vehicle_types").select("id").eq("is_active", true).order("size_rank").limit(1).single();
  if (vtError) throw vtError;
  vehicleTypeId = vt.id;
});

afterAll(async () => {
  // Local database only (D64). Orders with a succeeded payment cannot be deleted — that is the point;
  // the local database is reset before every run.
  for (const id of createdOrders) {
    await service.from("orders").update({ status: "pending_payment", paid_at: null, carrier_id: null }).eq("id", id);
    await service.from("orders").delete().eq("id", id);
  }
  // Customers with remaining orders cannot be deleted (FK restrict, D77): detach is not possible, so only
  // users without orders are removed; the local reset cleans the rest.
  await deleteCreatedUsers().catch(() => undefined);
});

describe("payment deadline (D88)", () => {
  it("is set on insert: now + 60 min for a far pickup", async () => {
    const o = await newOrder(customerA.id);
    const due = new Date((await order(o.id)).payment_due_at).getTime();
    expect(Math.abs(due - (Date.now() + 60 * 60_000))).toBeLessThan(2 * 60_000);
  });

  it("is never shorter than 30 min (minimum Stripe session) for a close pickup", async () => {
    const o = await newOrder(customerA.id, soonPickup());
    const due = new Date((await order(o.id)).payment_due_at).getTime();
    expect(Math.abs(due - (Date.now() + 30 * 60_000))).toBeLessThan(2 * 60_000);
  });

  it("cannot be changed, not even by the service role", async () => {
    const o = await newOrder(customerA.id);
    const { error } = await service.from("orders").update({ payment_due_at: new Date().toISOString() }).eq("id", o.id);
    expect(error).not.toBeNull();
  });
});

describe("start_order_payment", () => {
  it("records one open session per order", async () => {
    const o = await newOrder(customerA.id);
    const s = await startPayment(o.id);
    const { data } = await service.from("payments").select("status, amount_cents, currency, transfer_group").eq("stripe_checkout_session_id", s).single();
    expect(data).toEqual({ status: "pending", amount_cents: TOTAL, currency: "eur", transfer_group: o.order_number });
    await expect(startPayment(o.id)).rejects.toBeTruthy(); // a second open session is refused
  });

  it("refuses an amount different from order_charges.total_cents", async () => {
    const o = await newOrder(customerA.id);
    await expect(startPayment(o.id, TOTAL - 1)).rejects.toBeTruthy();
  });

  it("refuses an order that is not awaiting payment", async () => {
    const o = await newOrder(customerA.id);
    await check(service.rpc("expire_order", { p_order_id: o.id, p_source: "customer_app", p_force: true }));
    await expect(startPayment(o.id)).rejects.toBeTruthy();
  });
});

describe("confirm_order_payment (webhook)", () => {
  it("matching amount → paid, paid_at, history from stripe_webhook", async () => {
    const o = await newOrder(customerA.id);
    const s = await startPayment(o.id);
    const { data, error } = await confirm(s);
    expect(error).toBeNull();
    expect(data).toMatchObject({ result: "paid", order_id: o.id, order_number: o.order_number });
    const row = await order(o.id);
    expect(row.status).toBe("paid");
    expect(row.paid_at).not.toBeNull();
    const { data: hist } = await service.from("order_status_history").select("from_status, to_status, source").eq("order_id", o.id).order("id");
    expect(hist?.at(-1)).toEqual({ from_status: "pending_payment", to_status: "paid", source: "stripe_webhook" });
    const { data: pay } = await service.from("payments").select("status, stripe_payment_intent_id, stripe_charge_id, review_reason").eq("stripe_checkout_session_id", s).single();
    expect(pay?.status).toBe("succeeded");
    expect(pay?.stripe_payment_intent_id).toMatch(/^pi_/);
    expect(pay?.stripe_charge_id).toMatch(/^ch_/);
    expect(pay?.review_reason).toBeNull();
  });

  it("the same session confirmed again → already_processed, nothing changes", async () => {
    const o = await newOrder(customerA.id);
    const s = await startPayment(o.id);
    await check(confirm(s));
    const { count: before } = await service.from("order_status_history").select("id", { count: "exact", head: true }).eq("order_id", o.id);
    const { data } = await confirm(s);
    expect(data).toMatchObject({ result: "already_processed", status: "paid" });
    const { count: after } = await service.from("order_status_history").select("id", { count: "exact", head: true }).eq("order_id", o.id);
    expect(after).toBe(before);
  });

  it("different amount → payment_review, not paid", async () => {
    const o = await newOrder(customerA.id);
    const s = await startPayment(o.id);
    const { data } = await confirm(s, TOTAL - 100);
    expect(data).toMatchObject({ result: "review", reason: "amount_mismatch", status: "payment_review" });
    const row = await order(o.id);
    expect(row.status).toBe("payment_review");
    expect(row.paid_at).toBeNull();
  });

  it("different currency → payment_review", async () => {
    const o = await newOrder(customerA.id);
    const s = await startPayment(o.id);
    const { data } = await confirm(s, TOTAL, "usd");
    expect(data).toMatchObject({ result: "review", reason: "currency_mismatch" });
    expect((await order(o.id)).status).toBe("payment_review");
  });

  it("payment for an expired order → payment_review (late_payment)", async () => {
    const o = await newOrder(customerA.id);
    const s = await startPayment(o.id);
    await check(service.rpc("expire_order_payment", { p_session_id: s }));
    await check(service.rpc("expire_order", { p_order_id: o.id, p_source: "system_job", p_force: true }));
    const { data } = await confirm(s);
    expect(data).toMatchObject({ result: "review", reason: "late_payment", status: "payment_review" });
  });

  it("unknown session → error (the handler logs it)", async () => {
    const { error } = await confirm(`cs_test_${randomUUID()}`);
    expect(error).not.toBeNull();
  });

  it("an order with a received payment cannot be deleted", async () => {
    const o = await newOrder(customerA.id);
    const s = await startPayment(o.id, TOTAL);
    await confirm(s, TOTAL - 1); // payment_review, payment succeeded
    await service.from("orders").update({ status: "pending_payment" }).eq("id", o.id);
    const { error } = await service.from("orders").delete().eq("id", o.id);
    expect(error).not.toBeNull();
  });
});

describe("expiry", () => {
  it("expire_order does not expire an order before its deadline", async () => {
    const o = await newOrder(customerA.id);
    const { data } = await service.rpc("expire_order", { p_order_id: o.id, p_source: "stripe_webhook" });
    expect(data).toBe(false);
    expect((await order(o.id)).status).toBe("pending_payment");
  });

  it("expire_order does not expire an order with an open session, even forced", async () => {
    const o = await newOrder(customerA.id);
    await startPayment(o.id);
    const { data } = await service.rpc("expire_order", { p_order_id: o.id, p_source: "customer_app", p_force: true });
    expect(data).toBe(false);
  });

  it("session expired + forced → expired with history; a new session is then refused", async () => {
    const o = await newOrder(customerA.id);
    const s = await startPayment(o.id);
    const { data: orderId } = await service.rpc("expire_order_payment", { p_session_id: s });
    expect(orderId).toBe(o.id);
    const { data } = await service.rpc("expire_order", { p_order_id: o.id, p_source: "customer_app", p_changed_by: customerA.id, p_force: true });
    expect(data).toBe(true);
    expect((await order(o.id)).status).toBe("expired");
    const { data: hist } = await service.from("order_status_history").select("to_status, source, changed_by").eq("order_id", o.id).order("id");
    expect(hist?.at(-1)).toEqual({ to_status: "expired", source: "customer_app", changed_by: customerA.id });
  });

  it("expire_unpaid_orders leaves orders before the deadline alone", async () => {
    const o = await newOrder(customerA.id);
    await check(service.rpc("expire_unpaid_orders"));
    expect((await order(o.id)).status).toBe("pending_payment");
  });

  it("an expired session cannot be expired twice and a succeeded payment stays succeeded", async () => {
    const o = await newOrder(customerA.id);
    const s = await startPayment(o.id);
    await check(confirm(s));
    await check(service.rpc("expire_order_payment", { p_session_id: s }));
    const { data } = await service.from("payments").select("status").eq("stripe_checkout_session_id", s).single();
    expect(data?.status).toBe("succeeded");
  });
});

describe("refunds (model)", () => {
  it("only for a succeeded payment, and the sum cannot exceed the payment", async () => {
    const o = await newOrder(customerA.id);
    const s = await startPayment(o.id);
    const { data: pay } = await service.from("payments").select("id").eq("stripe_checkout_session_id", s).single();
    const refund = (amount: number) => service.from("refunds").insert({ order_id: o.id, payment_id: pay!.id, kind: "admin", amount_cents: amount, reason: "Test" });
    expect((await refund(100)).error).not.toBeNull(); // payment still pending
    await check(confirm(s));
    await check(refund(TOTAL - 200));
    expect((await refund(201)).error).not.toBeNull();
    await check(refund(200));
  });
});

describe("browsers cannot change payment state", () => {
  let o: { id: string; order_number: string };
  let session: string;

  beforeAll(async () => {
    o = await newOrder(customerA.id);
    session = await startPayment(o.id);
  });

  it("customer cannot update the order status or paid_at", async () => {
    await customerA.client.from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", o.id);
    expect((await order(o.id)).status).toBe("pending_payment");
  });

  it("customer cannot insert, update or delete payments", async () => {
    const ins = await customerA.client.from("payments").insert({ order_id: o.id, amount_cents: 1, stripe_checkout_session_id: "cs_x", transfer_group: "x", expires_at: new Date().toISOString() });
    expect(ins.error).not.toBeNull();
    await customerA.client.from("payments").update({ status: "succeeded" }).eq("stripe_checkout_session_id", session);
    await customerA.client.from("payments").delete().eq("stripe_checkout_session_id", session);
    const { data } = await service.from("payments").select("status").eq("stripe_checkout_session_id", session).single();
    expect(data?.status).toBe("pending");
  });

  for (const fn of ["confirm_order_payment", "start_order_payment", "expire_order_payment", "fail_order_payment", "expire_order", "expire_unpaid_orders"]) {
    it(`customer and anon cannot call ${fn}`, async () => {
      for (const client of [customerA.client, anon]) {
        const { error } = await client.rpc(fn, {});
        expect(error).not.toBeNull();
      }
    });
  }

  it("customer cannot call confirm_order_payment with real arguments", async () => {
    const { error } = await customerA.client.rpc("confirm_order_payment", { p_session_id: session, p_payment_intent_id: "pi_x", p_charge_id: "ch_x", p_amount_cents: TOTAL, p_currency: "eur" });
    expect(error).not.toBeNull();
    expect((await order(o.id)).status).toBe("pending_payment");
  });

  it("service role cannot write payments directly (only through the functions)", async () => {
    const { error } = await service.from("payments").update({ status: "succeeded" }).eq("stripe_checkout_session_id", session);
    expect(error).not.toBeNull();
  });
});

describe("visibility", () => {
  let paidOrder: { id: string; order_number: string };

  beforeAll(async () => {
    paidOrder = await newOrder(customerA.id);
    await check(confirm(await startPayment(paidOrder.id)));
    await check(service.from("email_outbox").insert({ template_code: "order_paid", order_id: paidOrder.id, to_address: customerA.email, subject: "s", html: "h", text_body: "t", status: "captured_dev" }));
    await check(service.from("stripe_events").insert({ event_id: `evt_${randomUUID()}`, type: "checkout.session.completed", livemode: false }));
    // assigned to the carrier (Stage 4 RPC; here directly)
    await check(service.from("orders").update({ carrier_id: carrier.id, status: "assigned" }).eq("id", paidOrder.id));
  });

  it("customer reads own payments only", async () => {
    const { data } = await customerA.client.from("payments").select("order_id");
    expect(data?.length).toBeGreaterThan(0);
    expect(new Set(data!.map((r) => r.order_id)).size).toBeGreaterThan(0);
    const own = new Set(createdOrders);
    expect(data!.every((r) => own.has(r.order_id))).toBe(true);
    const { data: other } = await customerB.client.from("payments").select("id");
    expect(other).toEqual([]);
  });

  it("carrier (even assigned) and anon see no payments or refunds", async () => {
    for (const client of [carrier.client, anon]) {
      for (const table of ["payments", "refunds"]) {
        const { data } = await client.from(table).select("*");
        expect(data ?? []).toEqual([]);
      }
    }
  });

  it("admin reads all payments", async () => {
    const { data } = await admin.client.from("payments").select("order_id").eq("order_id", paidOrder.id);
    expect(data?.length).toBe(1);
  });

  for (const table of ["stripe_events", "email_outbox"]) {
    it(`${table} is not readable or writable by anon, customer, carrier or admin`, async () => {
      for (const client of [anon, customerA.client, carrier.client, admin.client]) {
        const { data } = await client.from(table).select("*");
        expect(data ?? []).toEqual([]);
        const { error } = await client.from(table).insert(table === "stripe_events" ? { event_id: "evt_x", type: "x", livemode: false } : { template_code: "x", to_address: "a@b.c", subject: "s", html: "h", text_body: "t" });
        expect(error).not.toBeNull();
      }
    });
  }

  it("settings.payment_window_minutes: admin can change it, customer cannot read it", async () => {
    const { error } = await admin.client.from("settings").update({ payment_window_minutes: 60 }).eq("id", true);
    expect(error).toBeNull();
    const { data } = await customerA.client.from("settings").select("payment_window_minutes");
    expect(data ?? []).toEqual([]);
  });
});
