import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, localSql, service, type TestUser } from "./helpers";
import { HOUR, activeCarrier, check, listedIds, run, setupJobContext, teardownJobContext, vat, type DbError } from "./job-fixtures";

// Storage chain (D153, D169–D173; migration storage_chain): "ritiro Transigo → deposito → consegna Transigo" as linked
// orders created in one transaction, one payment and one invoice for the group, group cancellation and refunds,
// customer_order_warehouse(). LOCAL database only (D64).

let admin: TestUser;
let customer: TestUser; // private
let business: TestUser;
let otherCustomer: TestUser;
let draftList: { id: string; version: number }; // clone of the active list (boxes S/M/L)
let vt: Record<string, string>;
let warehouseId: string;

const romeDate = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date(Date.now() + offsetDays * 24 * HOUR));

const line = (sort: number, legIndex: number | null, type: string, net: number, group: string) => {
  const vatCents = Math.round((net * 22) / 100);
  return { sort_order: sort, leg_index: legIndex, line_type: type, label_it: `Voce ${sort}`, quantity: 1, unit_amount_cents: net, net_cents: net, vat_cents: vatCents, gross_cents: net + vatCents, carrier_share_group: group };
};
type Line = ReturnType<typeof line>;

const BILLING = { first_name: "Mario", last_name: "Rossi", fiscal_code: "RSSMRA80A01F205X", street: "Via Roma 1", city: "Firenze", postal_code: "50123", province: "FI" };
const charges = (lines: Line[], customerType: "private" | "business" = "private", patch: Record<string, unknown> = {}) => {
  const net = lines.reduce((s, l) => s + l.net_cents, 0);
  const vatCents = lines.reduce((s, l) => s + l.vat_cents, 0);
  return {
    price_list_id: draftList.id, price_list_version: draftList.version, customer_type: customerType, vat_rate_bp: 2200,
    subtotal_cents: net, vat_cents: vatCents, total_cents: net + vatCents, porter_overtime_rate_cents: 3_500,
    billing_details: BILLING, terms_accepted_at: "2026-11-12T10:00:00Z", terms_version: "2026-11-01", quoted_at: "2026-11-12T10:00:00Z",
    ...patch,
  };
};

const STORAGE_TOTAL = 7_320; // 6 000 + 22 % IVA
const TRANSPORT_TOTAL = 12_200; // 10 000 + 22 % IVA

/** 09:00 UTC (10:00 / 11:00 Rome) on a Rome date. */
const windowOn = (date: string) => {
  const start = new Date(`${date}T09:00:00Z`);
  return { pickup_date: date, pickup_window_start: start.toISOString(), pickup_window_end: new Date(start.getTime() + 2 * HOUR).toISOString() };
};

const WAREHOUSE_POINT = { address: "Via Magazzino 2, 50127 Firenze FI", city: "Firenze", postal_code: "50127", province: "FI", lat: 43.8, lng: 11.2 };
const HOME = { address: "Via Roma 1, 50123 Firenze FI", city: "Firenze", postal_code: "50123", province: "FI", lat: 43.77, lng: 11.25 };

type TransportOpts = { role: "intake" | "outbound"; date: string; warehouse?: string; customerId?: string; legs?: number; chargesPatch?: Record<string, unknown> };

function transportPayload(o: TransportOpts) {
  const wh = o.warehouse ?? warehouseId;
  const from = o.role === "intake" ? HOME : WAREHOUSE_POINT;
  const to = o.role === "intake" ? WAREHOUSE_POINT : HOME;
  const leg = (index: number) => ({
    leg_index: index,
    pickup_address: from.address, pickup_place_id: "place-from", pickup_lat: from.lat, pickup_lng: from.lng,
    pickup_city: from.city, pickup_postal_code: from.postal_code, pickup_province: from.province,
    pickup_warehouse_id: o.role === "outbound" ? wh : null,
    delivery_address: to.address, delivery_place_id: "place-to", delivery_lat: to.lat, delivery_lng: to.lng,
    delivery_city: to.city, delivery_postal_code: to.postal_code, delivery_province: to.province,
    delivery_warehouse_id: o.role === "intake" ? wh : null,
    distance_m: 8_000, duration_s: 1_200, ...windowOn(o.date),
    pickup_floor: 0, pickup_has_elevator: false, delivery_floor: 0, delivery_has_elevator: false, is_urgent: false,
    porter_package_code: null, porters_count: 0, porters_included_hours: null, porter_overtime_grace_minutes: null,
  });
  const lines = [line(0, 0, "transport", 10_000, "transport")];
  return {
    customer_id: o.customerId ?? customer.id,
    vehicle_type_id: vt.van_medium,
    goods_description: "Mobili del soggiorno", items_count: 6, weight_kg: 120, goods_dimensions_note: null,
    largest_item_length_cm: null, largest_item_width_cm: null, largest_item_height_cm: null, pallets_count: null, load_category: null,
    packing_items_count: 0,
    pickup_contact_name: "Mario Rossi", pickup_contact_phone: "+393331234567",
    delivery_contact_name: "Mario Rossi", delivery_contact_phone: "+393331234567",
    customer_notes: null, storage: null,
    legs: Array.from({ length: o.legs ?? 1 }, (_, i) => leg(i)),
    charges: charges(lines, "private", o.chargesPatch),
    lines,
    carrier_terms: [{ leg_index: 0, carrier_amount_cents: 7_000, transport_carrier_cents: 7_000, porters_carrier_cents: 0, packing_carrier_cents: 0 }],
  };
}

type ChainOpts = {
  start?: string; end?: string; intake?: boolean; outbound?: boolean; box?: string; customerId?: string; warehouse?: string;
  intakePatch?: Partial<TransportOpts>; outboundPatch?: Partial<TransportOpts>;
};

function chainPayload(o: ChainOpts = {}) {
  const start = o.start ?? romeDate(3);
  const end = o.end ?? romeDate(40);
  const customerId = o.customerId ?? customer.id;
  const intake = o.intake ?? true;
  const outbound = o.outbound ?? true;
  const lines = [line(0, null, "storage", 6_000, "none")];
  return {
    service_type: "storage",
    customer_id: customerId,
    goods_description: "Mobili del soggiorno",
    customer_notes: null,
    booking: {
      warehouse_id: o.warehouse ?? warehouseId, unit: "box", box_code: o.box ?? "m", pallets: null,
      start_date: start, end_date: end, payment_plan: "upfront",
      intake: intake ? "transigo" : "self", outbound: outbound ? "transigo" : "self",
    },
    charges: charges(lines),
    lines,
    ...(intake ? { intake_transport: transportPayload({ role: "intake", date: start, customerId, warehouse: o.warehouse, ...o.intakePatch }) } : {}),
    ...(outbound ? { outbound_transport: transportPayload({ role: "outbound", date: end, customerId, warehouse: o.warehouse, ...o.outboundPatch }) } : {}),
  };
}

type Chain = { id: string; order_number: string; orders: { id: string; order_number: string; role: "intake" | "storage" | "outbound" }[] };
const create = (p: unknown) => service.rpc("create_service_order", { p });
const createChain = async (o: ChainOpts = {}) => (await check(create(chainPayload(o)))) as Chain;
const roleId = (c: Chain, role: "intake" | "storage" | "outbound") => c.orders.find((x) => x.role === role)!.id;
const groupIds = (c: Chain) => c.orders.map((x) => x.id);
const refused = async (p: unknown, code: string, reason?: RegExp) => {
  const { error } = await create(p);
  expect((error as DbError)?.code, (error as DbError)?.message).toBe(code);
  if (reason) expect((error as DbError)?.message).toMatch(reason);
};

const statuses = async (ids: string[]) => {
  const rows = await check(service.from("orders").select("id, status").in("id", ids));
  return ids.map((id) => rows.find((r) => r.id === id)!.status as string);
};

async function startPayment(rootId: string, amount: number) {
  const session = `cs_test_${randomUUID()}`;
  const paymentId = (await check(service.rpc("start_order_payment", { p_order_id: rootId, p_session_id: session, p_amount_cents: amount, p_expires_at: new Date(Date.now() + HOUR).toISOString() }))) as string;
  return { session, paymentId };
}
const confirm = (session: string, amount: number) =>
  check(service.rpc("confirm_order_payment", { p_session_id: session, p_payment_intent_id: `pi_${randomUUID()}`, p_charge_id: `ch_${randomUUID()}`, p_amount_cents: amount, p_currency: "eur" })) as Promise<Record<string, unknown>>;

const groupTotal = (c: Chain) =>
  c.orders.reduce((s, o) => s + (o.role === "storage" ? STORAGE_TOTAL : TRANSPORT_TOTAL), 0);

async function paidChain(o: ChainOpts = {}) {
  const c = await createChain(o);
  const { session, paymentId } = await startPayment(c.id, groupTotal(c));
  await confirm(session, groupTotal(c));
  return { chain: c, paymentId };
}

const sql = (s: string) => {
  const res = localSql(s);
  if (!res.ok) throw new Error(res.output);
  return res.output;
};
/** Test-only state changes the API cannot make (triggers off, CHECK constraints still on). */
const force = (s: string) => sql(`set session_replication_role = replica; ${s}`);

const cancel = (orderId: string, customerId = customer.id) =>
  service.rpc("customer_cancel_order", { p_order_id: orderId, p_customer_id: customerId, p_reason: null }).single<{
    result: string; fee_cents: number; refund_cents: number; refund_id: string | null; order_number: string; refund_ids: string[] | null;
  }>();

beforeAll(async () => {
  const ctx = await setupJobContext(); // its own warehouse: replaced below by the one of this file
  ({ admin, customer, vt } = ctx);
  [business, otherCustomer] = await Promise.all([createUser({}), createUser({})]);
  await run(service.from("customers").insert([
    { profile_id: business.id, customer_type: "business", company_name: "Delta Srl", vat_number: vat(), sdi_code: "M5UXCR1" },
    { profile_id: otherCustomer.id, customer_type: "private" },
  ]));
  const activeId = (await check(service.from("price_lists").select("id").eq("status", "active").single())).id as string;
  const draftId = (await check(admin.client.rpc("clone_price_list", { p_source_id: activeId }))) as string;
  draftList = await check(service.from("price_lists").select("id, version").eq("id", draftId).single());

  await run(service.from("warehouses").update({ is_active: false }).eq("is_active", true));
  warehouseId = (await check(service.from("warehouses").insert({
    name: "Magazzino Catena", ...WAREHOUSE_POINT, is_active: true, pallet_capacity: 10,
  }).select("id").single())).id as string;
  await run(admin.client.from("warehouse_box_capacity").insert([
    { warehouse_id: warehouseId, box_code: "m", quantity: 100 },
    { warehouse_id: warehouseId, box_code: "l", quantity: 1 }, // the race for the last box
  ]));
});

afterAll(async () => {
  await service.from("warehouses").update({ is_active: false }).neq("name", "");
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("create_service_order: the chain (D153)", () => {
  it("ritiro + deposito + consegna: three orders, root = intake transport, children point to it", async () => {
    const c = await createChain();
    expect(c.orders.map((o) => o.role)).toEqual(["intake", "storage", "outbound"]);
    expect(c.id).toBe(roleId(c, "intake"));
    const rows = await check(service.from("orders")
      .select("id, service_type, parent_order_id, status, payment_due_at, vehicle_type_id, pickup_window_start").in("id", groupIds(c)));
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    expect(byId(roleId(c, "intake"))).toMatchObject({ service_type: "transport", parent_order_id: null, status: "pending_payment" });
    expect(byId(roleId(c, "storage"))).toMatchObject({ service_type: "storage", parent_order_id: c.id, status: "pending_payment", vehicle_type_id: null });
    expect(byId(roleId(c, "outbound"))).toMatchObject({ service_type: "transport", parent_order_id: c.id, status: "pending_payment" });
    // one payment deadline for the group (D88)
    expect(new Set(rows.map((r) => r.payment_due_at)).size).toBe(1);
    // the legs go to / from the warehouse of the booking
    const legs = await check(service.from("order_legs").select("order_id, pickup_warehouse_id, delivery_warehouse_id").in("order_id", groupIds(c)));
    expect(legs.find((l) => l.order_id === roleId(c, "intake"))).toMatchObject({ pickup_warehouse_id: null, delivery_warehouse_id: warehouseId });
    expect(legs.find((l) => l.order_id === roleId(c, "outbound"))).toMatchObject({ pickup_warehouse_id: warehouseId, delivery_warehouse_id: null });
    expect(await check(service.from("warehouse_bookings").select("intake, outbound").eq("order_id", roleId(c, "storage")).single()))
      .toEqual({ intake: "transigo", outbound: "transigo" });
  });

  it("porto io + consegna: root = storage order, the outbound points to it", async () => {
    const c = await createChain({ intake: false });
    expect(c.orders.map((o) => o.role)).toEqual(["storage", "outbound"]);
    expect(c.id).toBe(roleId(c, "storage"));
    expect((await check(service.from("orders").select("parent_order_id").eq("id", roleId(c, "outbound")).single())).parent_order_id).toBe(c.id);
  });

  it("ritiro + ritiro io: two orders; a single storage order still returns orders: [storage]", async () => {
    const c = await createChain({ outbound: false });
    expect(c.orders.map((o) => o.role)).toEqual(["intake", "storage"]);
    const single = await createChain({ intake: false, outbound: false });
    expect(single.orders.map((o) => o.role)).toEqual(["storage"]);
    expect(single.id).toBe(roleId(single, "storage"));
  });

  it("refused: transport without Transigo, Transigo without transport, wrong dates, warehouse, customer, legs, charges", async () => {
    const p = chainPayload();
    await refused({ ...p, booking: { ...p.booking, intake: "self" } }, "22023", /need their transport/);
    await refused({ ...chainPayload({ outbound: false }), booking: { ...p.booking, outbound: "transigo" } }, "22023", /need their transport/);
    await refused({ ...p, intake_transport: "x" }, "22023");
    await refused(chainPayload({ intakePatch: { date: romeDate(4) } }), "22023", /intake on start_date/);
    await refused(chainPayload({ outboundPatch: { date: romeDate(39) } }), "22023", /outbound on end_date/);
    const otherWh = (await check(service.from("warehouses").insert({ name: "Altro", ...WAREHOUSE_POINT, is_active: false }).select("id").single())).id as string;
    await refused(chainPayload({ intakePatch: { warehouse: otherWh } }), "22023", /warehouse of the booking/);
    await refused(chainPayload({ outboundPatch: { customerId: otherCustomer.id } }), "22023", /one customer/);
    await refused(chainPayload({ intakePatch: { legs: 2 } }), "22023", /one leg/);
    await refused(chainPayload({ outboundPatch: { chargesPatch: { billing_details: { ...BILLING, street: "Via Altra 9" } } } }), "22023", /share price list/);
    await refused(chainPayload({ outboundPatch: { chargesPatch: { terms_version: "2026-10-01" } } }), "22023", /share price list/);
  });

  it("a refused chain leaves nothing behind (one transaction)", async () => {
    const count = async () => (await service.from("orders").select("id", { count: "exact", head: true }).eq("customer_id", customer.id)).count;
    const before = await count();
    await refused(chainPayload({ outboundPatch: { chargesPatch: { terms_version: "2026-10-01" } } }), "22023");
    expect(await count()).toBe(before);
  });

  it("create_order is unchanged: no parent, warehouse legs only with storage; create_transport_order is internal", async () => {
    const p = transportPayload({ role: "intake", date: romeDate(3) });
    const { error } = await service.rpc("create_order", { p });
    expect((error as DbError)?.message).toMatch(/warehouse leg without storage/);
    const plain = { ...p, legs: [{ ...p.legs[0], delivery_warehouse_id: null }] };
    const ok = (await check(service.rpc("create_order", { p: plain }))) as { id: string };
    expect((await check(service.from("orders").select("parent_order_id, service_type").eq("id", ok.id).single()))).toEqual({ parent_order_id: null, service_type: "transport" });
    for (const client of [service, customer.client, admin.client]) {
      expect((await client.rpc("create_transport_order", { p, p_parent_order_id: null, p_chain_role: "intake", p_warehouse_id: warehouseId })).error).not.toBeNull();
    }
  });

  it("a child cannot be attached to a paid order or to another customer's order (trigger)", async () => {
    const { chain } = await paidChain({ intake: false, outbound: false });
    const attach = (customerId: string, parentId: string) => localSql(`
      begin;
      insert into public.orders (customer_id, parent_order_id, service_type, pickup_window_start)
      values ('${customerId}', '${parentId}', 'storage', now() + interval '3 days');
      rollback;`);
    for (const [customerId, parentId] of [[customer.id, chain.id], [otherCustomer.id, (await createChain({ intake: false, outbound: false })).id]]) {
      const res = attach(customerId, parentId);
      expect(res.ok).toBe(false);
      expect(res.output).toMatch(/unpaid first order of the same customer/);
    }
  });
});

describe("payment of the group", () => {
  it("only on the root, for the sum of the group; the webhook pays every order; a repeated event changes nothing", async () => {
    const c = await createChain();
    const total = groupTotal(c);
    for (const child of [roleId(c, "storage"), roleId(c, "outbound")]) {
      const { error } = await service.rpc("start_order_payment", { p_order_id: child, p_session_id: `cs_test_${randomUUID()}`, p_amount_cents: STORAGE_TOTAL, p_expires_at: new Date(Date.now() + HOUR).toISOString() });
      expect((error as DbError)?.details).toBe("not_group_root");
    }
    const wrong = await service.rpc("start_order_payment", { p_order_id: c.id, p_session_id: `cs_test_${randomUUID()}`, p_amount_cents: TRANSPORT_TOTAL, p_expires_at: new Date(Date.now() + HOUR).toISOString() });
    expect((wrong.error as DbError)?.message).toMatch(/differs from the order total/);

    const { session } = await startPayment(c.id, total);
    const first = await confirm(session, total);
    expect(first).toMatchObject({ result: "paid", order_id: c.id, status: "paid" });
    expect([...(first.group_order_ids as string[])].sort()).toEqual([...groupIds(c)].sort());
    expect(await statuses(groupIds(c))).toEqual(["paid", "paid", "paid"]);
    const hist = await check(service.from("order_status_history").select("order_id, to_status, source").in("order_id", groupIds(c)).eq("to_status", "paid"));
    expect(hist.length).toBe(3);

    const again = await confirm(session, total);
    expect(again.result).toBe("already_processed");
    expect((await check(service.from("order_status_history").select("id").in("order_id", groupIds(c)).eq("to_status", "paid"))).length).toBe(3);
  });

  it("the transports of the group reach carriers only after the group is paid", async () => {
    const carrier = await activeCarrier("van_medium");
    const c = await createChain({ start: romeDate(5) });
    expect(await listedIds(carrier.user)).not.toContain(roleId(c, "intake"));
    const { session } = await startPayment(c.id, groupTotal(c));
    await confirm(session, groupTotal(c));
    const listed = await listedIds(carrier.user);
    expect(listed).toContain(roleId(c, "intake"));
    expect(listed).toContain(roleId(c, "outbound"));
    expect(listed).not.toContain(roleId(c, "storage"));
  });

  it("expire_order on any order expires the whole group; expire_unpaid_orders walks roots only", async () => {
    const c = await createChain();
    expect(await check(service.rpc("expire_order", { p_order_id: roleId(c, "outbound"), p_source: "customer_app", p_force: true }))).toBe(true);
    expect(await statuses(groupIds(c))).toEqual(["expired", "expired", "expired"]);

    const d = await createChain();
    force(`update public.orders set payment_due_at = now() - interval '10 minutes' where id in (${groupIds(d).map((id) => `'${id}'`).join(",")});`);
    await run(service.rpc("expire_unpaid_orders"));
    expect(await statuses(groupIds(d))).toEqual(["expired", "expired", "expired"]);
    const n = await check(service.from("order_status_history").select("id").in("order_id", groupIds(d)).eq("to_status", "expired"));
    expect(n.length).toBe(3);
  });

  it("an open Checkout session on the root keeps the group alive", async () => {
    const c = await createChain();
    await startPayment(c.id, groupTotal(c));
    expect(await check(service.rpc("expire_order", { p_order_id: roleId(c, "storage"), p_source: "customer_app", p_force: true }))).toBe(false);
    expect(await statuses(groupIds(c))).toEqual(["pending_payment", "pending_payment", "pending_payment"]);
  });

  it("amount mismatch → the whole group in payment_review; mark_paid pays the whole group", async () => {
    const c = await createChain();
    const { session, paymentId } = await startPayment(c.id, groupTotal(c));
    const r = await confirm(session, groupTotal(c) - 100);
    expect(r).toMatchObject({ result: "review", reason: "amount_mismatch" });
    expect(await statuses(groupIds(c))).toEqual(["payment_review", "payment_review", "payment_review"]);
    const res = await check(service.rpc("admin_resolve_payment_review", { p_payment_id: paymentId, p_admin_id: admin.id, p_action: "mark_paid" }).single<{ result: string }>());
    expect(res.result).toBe("paid");
    expect(await statuses(groupIds(c))).toEqual(["paid", "paid", "paid"]);
  });

  it("late payment of an expired group → review; refund splits the payment per order (children first, root last)", async () => {
    const c = await createChain();
    const { session, paymentId } = await startPayment(c.id, groupTotal(c));
    // the session is still open; the order expires anyway (as when the cron ran before the webhook)
    force(`update public.payments set status = 'expired' where id = '${paymentId}';`);
    await run(service.rpc("expire_order", { p_order_id: c.id, p_source: "system_job", p_force: true }));
    force(`update public.payments set status = 'pending' where id = '${paymentId}';`);
    const r = await confirm(session, groupTotal(c));
    expect(r).toMatchObject({ result: "review", reason: "late_payment" });
    expect(await statuses(groupIds(c))).toEqual(["payment_review", "payment_review", "payment_review"]);

    const res = await check(service.rpc("admin_resolve_payment_review", { p_payment_id: paymentId, p_admin_id: admin.id, p_action: "refund" })
      .single<{ result: string; refund_cents: number; refund_ids: string[] }>());
    expect(res.result).toBe("refunded");
    expect(res.refund_cents).toBe(groupTotal(c));
    expect(res.refund_ids.length).toBe(3);
    const refunds = await check(service.from("refunds").select("order_id, amount_cents").in("id", res.refund_ids));
    const byOrder = Object.fromEntries(refunds.map((x) => [x.order_id, x.amount_cents]));
    expect(byOrder).toEqual({ [roleId(c, "intake")]: TRANSPORT_TOTAL, [roleId(c, "storage")]: STORAGE_TOTAL, [roleId(c, "outbound")]: TRANSPORT_TOTAL });
    expect(await statuses(groupIds(c))).toEqual(["refunded", "refunded", "refunded"]);
  });

  it("overpayment of a chain → overpaid_chain (refunded by hand, D141 open)", async () => {
    const c = await createChain();
    const { session, paymentId } = await startPayment(c.id, groupTotal(c));
    await confirm(session, groupTotal(c) + 500);
    const { error } = await service.rpc("admin_resolve_payment_review", { p_payment_id: paymentId, p_admin_id: admin.id, p_action: "refund" });
    expect((error as DbError)?.details).toBe("overpaid_chain");
    expect(await statuses(groupIds(c))).toEqual(["payment_review", "payment_review", "payment_review"]);
  });
});

describe("invoice and refunds of the group", () => {
  it("queue_invoice: one invoice on the root for the sum of the group", async () => {
    const { chain, paymentId } = await paidChain();
    const q = await check(service.rpc("queue_invoice", { p_payment_id: paymentId, p_provider: "demo" }).single<{ invoice_id: string; newly_queued: boolean }>());
    const inv = await check(service.from("invoices").select("order_id, net_cents, vat_cents, total_cents").eq("id", q.invoice_id).single());
    expect(inv).toEqual({ order_id: chain.id, net_cents: 26_000, vat_cents: 5_720, total_cents: groupTotal(chain) });
  });

  it("admin_refund_order on an order of the chain: at most its own remainder; full → only that order refunded", async () => {
    const { chain, paymentId } = await paidChain();
    const storage = roleId(chain, "storage");
    const tooMuch = await service.rpc("admin_refund_order", { p_order_id: storage, p_admin_id: admin.id, p_amount_cents: STORAGE_TOTAL + 1, p_reason_code: "goodwill" });
    expect((tooMuch.error as DbError)?.details).toBe("amount");
    const part = await check(service.rpc("admin_refund_order", { p_order_id: storage, p_admin_id: admin.id, p_amount_cents: 1_000, p_reason_code: "goodwill" })
      .single<{ refund_id: string; full_refund: boolean }>());
    expect(part.full_refund).toBe(false);
    const full = await check(service.rpc("admin_refund_order", { p_order_id: storage, p_admin_id: admin.id, p_amount_cents: STORAGE_TOTAL - 1_000, p_reason_code: "goodwill" })
      .single<{ refund_id: string; full_refund: boolean; new_status: string }>());
    expect(full).toMatchObject({ full_refund: true, new_status: "refunded" });
    expect(await statuses(groupIds(chain))).toEqual(["paid", "refunded", "paid"]);
    const rows = await check(service.from("refunds").select("order_id, payment_id").in("id", [part.refund_id, full.refund_id]));
    expect(rows.every((r) => r.order_id === storage && r.payment_id === paymentId)).toBe(true);

    // succeeded refunds count on the order refunded (refunded_cents ≤ its total)
    await run(service.rpc("record_refund_result", { p_refund_id: full.refund_id, p_stripe_refund_id: `re_${randomUUID()}`, p_status: "succeeded" }));
    expect((await check(service.from("order_charges").select("refunded_cents").eq("order_id", storage).single())).refunded_cents).toBe(STORAGE_TOTAL - 1_000);
  });

  it("the per-order cap holds in the table too (refunds trigger), also for the root", async () => {
    const { chain, paymentId } = await paidChain();
    const { error } = await service.from("refunds").insert({ order_id: chain.id, payment_id: paymentId, kind: "admin", amount_cents: TRANSPORT_TOTAL + 1, reason: "other" });
    expect(error).not.toBeNull();
    const other = await paidChain();
    const wrongPayment = await service.from("refunds").insert({ order_id: roleId(chain, "storage"), payment_id: other.paymentId, kind: "admin", amount_cents: 100, reason: "other" });
    expect(wrongPayment.error).not.toBeNull();
  });
});

describe("customer cancellation (D33, D38, D169, D170)", () => {
  it("the whole chain from any order: every order cancelled, one refund per order, storage in full", async () => {
    const { chain } = await paidChain();
    const r = await check(cancel(roleId(chain, "outbound")));
    expect(r).toMatchObject({ result: "cancelled", fee_cents: 0, refund_cents: groupTotal(chain), order_number: chain.order_number });
    expect(r.refund_ids!.length).toBe(3);
    expect(r.refund_id).toBe(r.refund_ids![0]);
    expect(await statuses(groupIds(chain))).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect((await check(service.from("warehouse_bookings").select("status").eq("order_id", roleId(chain, "storage")).single())).status).toBe("cancelled");
    const again = await check(cancel(chain.id));
    expect(again).toMatchObject({ result: "already_cancelled", fee_cents: 0 });
  });

  it("late: the D33 fee per transport from its own pickup window, storage refunded in full", async () => {
    const before = await check(service.from("settings").select("free_cancellation_hours").single());
    await run(service.from("settings").update({ free_cancellation_hours: 24 * 10 }).eq("id", true));
    try {
      const { chain } = await paidChain({ start: romeDate(3), end: romeDate(40) });
      const r = await check(cancel(chain.id));
      // intake (in 3 days) is late: 50 % of 12 200; outbound (in 40 days) and storage are free
      expect(r).toMatchObject({ result: "cancelled", fee_cents: 6_100, refund_cents: groupTotal(chain) - 6_100 });
      const fees = await check(service.from("order_charges").select("order_id, cancellation_fee_cents").in("order_id", groupIds(chain)));
      expect(Object.fromEntries(fees.map((f) => [f.order_id, f.cancellation_fee_cents]))).toEqual({
        [roleId(chain, "intake")]: 6_100, [roleId(chain, "storage")]: 0, [roleId(chain, "outbound")]: 0,
      });
    } finally {
      await run(service.from("settings").update({ free_cancellation_hours: before.free_cancellation_hours }).eq("id", true));
    }
  });

  it("a carrier on any transport of the chain → group_in_progress; nothing changes", async () => {
    const carrier = await activeCarrier("van_medium");
    const { chain } = await paidChain({ start: romeDate(6) });
    await run(carrier.user.client.rpc("accept_job", { p_order_id: roleId(chain, "outbound"), p_vehicle_id: carrier.vehicleId }));
    const { error } = await cancel(chain.id);
    expect((error as DbError)?.details).toBe("group_in_progress");
    expect(await statuses(groupIds(chain))).toEqual(["paid", "paid", "assigned"]);
  });

  it("storage from 00:00 Europe/Rome of start_date → storage_started (alone and in a chain)", async () => {
    const { chain: single } = await paidChain({ intake: false, outbound: false, start: romeDate(0) });
    expect(((await cancel(single.id)).error as DbError)?.details).toBe("storage_started");
    const { chain } = await paidChain({ intake: false, start: romeDate(0) });
    expect(((await cancel(roleId(chain, "outbound"))).error as DbError)?.details).toBe("storage_started");
    expect(await statuses(groupIds(chain))).toEqual(["paid", "paid"]);
  });

  it("a single storage order before its start: free, full refund", async () => {
    const { chain } = await paidChain({ intake: false, outbound: false, start: romeDate(1) });
    const r = await check(cancel(chain.id));
    expect(r).toMatchObject({ result: "cancelled", fee_cents: 0, refund_cents: STORAGE_TOTAL });
    expect(r.refund_ids!.length).toBe(1);
  });

  it("another customer cannot cancel the chain", async () => {
    const { chain } = await paidChain();
    const { error } = await cancel(roleId(chain, "storage"), otherCustomer.id);
    expect((error as DbError)?.details).toBe("order");
  });
});

describe("visibility of the group per role", () => {
  it("customer: the whole group; another customer: nothing", async () => {
    const { chain } = await paidChain();
    const own = await check(customer.client.from("orders").select("id, parent_order_id").in("id", groupIds(chain)));
    expect(own.length).toBe(3);
    expect((await check(customer.client.from("order_charges").select("order_id").in("order_id", groupIds(chain)))).length).toBe(3);
    expect((await check(customer.client.from("warehouse_bookings").select("order_id").eq("order_id", roleId(chain, "storage")))).length).toBe(1);
    expect((await check(otherCustomer.client.from("orders").select("id").in("id", groupIds(chain)))).length).toBe(0);
  });

  it("carrier of the outbound: only its transport — no storage order, booking, root or customer amounts", async () => {
    const carrier = await activeCarrier("van_medium");
    const { chain } = await paidChain({ start: romeDate(7) });
    await run(carrier.user.client.rpc("accept_job", { p_order_id: roleId(chain, "outbound"), p_vehicle_id: carrier.vehicleId }));
    const c = carrier.user.client;
    expect((await check(c.from("orders").select("id").in("id", groupIds(chain)))).map((r) => r.id)).toEqual([roleId(chain, "outbound")]);
    expect((await check(c.from("warehouse_bookings").select("order_id").eq("order_id", roleId(chain, "storage")))).length).toBe(0);
    expect((await check(c.from("order_charges").select("order_id").in("order_id", groupIds(chain)))).length).toBe(0);
    expect((await check(c.from("order_lines").select("order_id").in("order_id", groupIds(chain)))).length).toBe(0);
    expect((await check(c.from("invoices").select("id").in("order_id", groupIds(chain)))).length).toBe(0);
    expect((await check(c.from("payments").select("id").in("order_id", groupIds(chain)))).length).toBe(0);
  });

  it("admin: the whole group", async () => {
    const { chain } = await paidChain();
    expect((await check(admin.client.from("orders").select("id").in("id", groupIds(chain)))).length).toBe(3);
  });
});

describe("customer_order_warehouse (D171)", () => {
  it("the owner of a storage order gets name and address; nobody else; not for transports or expired orders", async () => {
    const { chain } = await paidChain({ intake: false, outbound: false });
    const rows = await check(customer.client.rpc("customer_order_warehouse", { p_order_id: chain.id }));
    expect(rows).toEqual([{ name: "Magazzino Catena", address: WAREHOUSE_POINT.address, city: "Firenze", postal_code: "50127", province: "FI", lat: 43.8, lng: 11.2 }]);

    const carrier = await activeCarrier("van_medium");
    for (const c of [otherCustomer.client, admin.client, carrier.user.client]) {
      expect(await check(c.rpc("customer_order_warehouse", { p_order_id: chain.id }))).toEqual([]);
    }
    expect((await anon.rpc("customer_order_warehouse", { p_order_id: chain.id })).error).not.toBeNull();

    const t = await paidChain({ intake: true, outbound: false });
    expect(await check(customer.client.rpc("customer_order_warehouse", { p_order_id: t.chain.id }))).toEqual([]); // the intake transport
    const expired = await createChain({ intake: false, outbound: false });
    await run(service.rpc("expire_order", { p_order_id: expired.id, p_source: "customer_app", p_force: true }));
    expect(await check(customer.client.rpc("customer_order_warehouse", { p_order_id: expired.id }))).toEqual([]);
  });

  it("the money and group functions are server-only", async () => {
    for (const client of [anon, customer.client, admin.client]) {
      expect((await client.rpc("order_group_root", { p_order_id: randomUUID() })).error).not.toBeNull();
      expect((await client.rpc("order_refundable_cents", { p_order_id: randomUUID() })).error).not.toBeNull();
    }
  });
});

describe("capacity with a chain (D156)", () => {
  it("race for the last box with full chains: exactly one succeeds, the others leave no orders behind", async () => {
    const before = (await service.from("orders").select("id", { count: "exact", head: true }).eq("customer_id", customer.id)).count ?? 0;
    const start = romeDate(20), end = romeDate(25);
    const results = await Promise.all(Array.from({ length: 5 }, () => create(chainPayload({ box: "l", start, end }))));
    const ok = results.filter((r) => !r.error);
    expect(ok.length).toBe(1);
    expect(results.filter((r) => r.error).every((r) => (r.error as DbError)?.code === "23P01")).toBe(true);
    const after = (await service.from("orders").select("id", { count: "exact", head: true }).eq("customer_id", customer.id)).count ?? 0;
    expect(after - before).toBe(3);
  });
});
