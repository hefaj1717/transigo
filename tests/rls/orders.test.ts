import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculatePrice } from "@/lib/pricing/calculate";
import { makeConfig } from "@/lib/pricing/__fixtures__/config";
import { planLegs, priceInputFor, type Endpoint } from "@/lib/booking/build";
import { buildOrderPayload } from "@/lib/booking/order-payload";
import { EMPTY_WIZARD_STATE, type WizardState } from "@/lib/booking/state";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";

// Stage 2b security tests (D63 — the stage is not done without them): orders and their snapshot tables.
// D29 (carrier never sees the customer price), D74 (porters per leg), D76 (quotes), D77 (data model).

const vat = () => Math.floor(Math.random() * 1e11).toString().padStart(11, "0");

const SHARED = ["orders", "order_legs", "order_status_history"] as const;
const CUSTOMER_PRICE = ["order_charges", "order_lines"] as const;
const CARRIER_MONEY = ["order_leg_carrier_terms"] as const;
const ORDER_TABLES = [...SHARED, ...CUSTOMER_PRICE, ...CARRIER_MONEY] as const;

let customerA: TestUser;
let customerB: TestUser;
let blockedCustomer: TestUser;
let carrier: TestUser;
let otherCarrier: TestUser;
let blockedCarrier: TestUser;
let admin: TestUser;
let blockedAdmin: TestUser;

let priceList: { id: string; version: number };
let vehicleTypeId: string;
let warehouseId: string;

let orderA: { id: string; order_number: string }; // customer A, assigned to `carrier`
let orderA2: { id: string; order_number: string }; // customer A, storage order, not assigned
let orderB: { id: string; order_number: string }; // customer B
let orderBlocked: { id: string; order_number: string }; // blocked customer, assigned to blocked carrier
const createdOrders: string[] = [];

const leg = (index: number, overrides: Record<string, unknown> = {}) => ({
  leg_index: index,
  pickup_address: "Via Roma 1, 20121 Milano MI",
  pickup_place_id: "place-pickup",
  pickup_lat: 45.4642,
  pickup_lng: 9.19,
  pickup_city: "Milano",
  pickup_postal_code: "20121",
  pickup_province: "MI",
  delivery_address: "Via Po 2, 10124 Torino TO",
  delivery_place_id: "place-delivery",
  delivery_lat: 45.0703,
  delivery_lng: 7.6869,
  delivery_city: "Torino",
  delivery_postal_code: "10124",
  delivery_province: "TO",
  distance_m: 143_122,
  duration_s: 5_400,
  pickup_date: "2026-12-01",
  pickup_window_start: "2026-12-01T09:00:00Z",
  pickup_window_end: "2026-12-01T11:00:00Z",
  pickup_floor: 0,
  pickup_has_elevator: false,
  delivery_floor: 2,
  delivery_has_elevator: true,
  is_urgent: false,
  ...overrides,
});

const line = (sort: number, legIndex: number | null, type: string, net: number, vatCents: number, group: string) => ({
  sort_order: sort,
  leg_index: legIndex,
  line_type: type,
  label_it: `Voce ${sort}`,
  quantity: 1,
  unit_amount_cents: net,
  net_cents: net,
  vat_cents: vatCents,
  gross_cents: net + vatCents,
  carrier_share_group: group,
});

/** A consistent one-leg order: transport 100 € + porters (parcels, 2 persons) 60 €, VAT 22 %. */
function simplePayload(customerId: string) {
  return {
    customer_id: customerId,
    vehicle_type_id: vehicleTypeId,
    goods_description: "Divano e 5 scatoloni",
    items_count: 6,
    weight_kg: 120,
    packing_items_count: 0,
    pickup_contact_name: "Mario Rossi",
    pickup_contact_phone: "+393331234567",
    delivery_contact_name: "Lucia Bianchi",
    delivery_contact_phone: "+393337654321",
    customer_notes: "Citofono 3",
    storage: null,
    legs: [leg(0, { porter_package_code: "parcels", porters_count: 2, porters_included_hours: 1, porter_overtime_grace_minutes: 15 })],
    charges: {
      price_list_id: priceList.id,
      price_list_version: priceList.version,
      customer_type: "private",
      vat_rate_bp: 2200,
      subtotal_cents: 16_000,
      vat_cents: 3_520,
      total_cents: 19_520,
      porter_overtime_rate_cents: 3_500,
      billing_details: { fiscal_code: "RSSMRA80A01F205X", street: "Via Roma 1", city: "Milano", postal_code: "20121", province: "MI" },
      terms_accepted_at: new Date().toISOString(),
      terms_version: "2026-11-01",
      quoted_at: new Date().toISOString(),
    },
    lines: [line(0, 0, "transport", 10_000, 2_200, "transport"), line(1, 0, "porters", 6_000, 1_320, "porters")],
    carrier_terms: [
      {
        leg_index: 0,
        carrier_amount_cents: 11_800,
        transport_carrier_cents: 7_000,
        porters_carrier_cents: 4_800,
        packing_carrier_cents: 0,
        porter_share_kind: "percent",
        porter_share_bp: 8000,
      },
    ],
  };
}

/** Storage order: A→warehouse, warehouse→B; porters at A (leg 0) and at B (leg 1) — D74. */
function storagePayload(customerId: string) {
  const base = simplePayload(customerId);
  const porters = (pkg: string, n: number, h: number) => ({ porter_package_code: pkg, porters_count: n, porters_included_hours: h, porter_overtime_grace_minutes: 15 });
  return {
    ...base,
    storage: { storage_type: "short_term", storage_billing_unit: "pallet_day", storage_days: 5, storage_pallets: 2, warehouse_id: warehouseId },
    legs: [
      leg(0, { delivery_warehouse_id: warehouseId, delivery_address: "Magazzino Transigo", delivery_city: "Milano", delivery_province: "MI", ...porters("bilocale", 2, 3) }),
      leg(1, {
        pickup_warehouse_id: warehouseId,
        pickup_address: "Magazzino Transigo",
        pickup_date: "2026-12-06",
        pickup_window_start: "2026-12-06T09:00:00Z",
        pickup_window_end: "2026-12-06T11:00:00Z",
        ...porters("parcels", 1, 1),
      }),
    ],
    charges: { ...base.charges, subtotal_cents: 44_500, vat_cents: 9_790, total_cents: 54_290 },
    lines: [
      line(0, 0, "transport", 10_000, 2_200, "transport"),
      line(1, 0, "porters", 18_000, 3_960, "porters"),
      line(2, 1, "transport", 10_000, 2_200, "transport"),
      line(3, 1, "porters", 3_000, 660, "porters"),
      line(4, null, "storage", 3_500, 770, "none"),
    ],
    carrier_terms: [
      { leg_index: 0, carrier_amount_cents: 21_400, transport_carrier_cents: 7_000, porters_carrier_cents: 14_400, porter_share_kind: "percent", porter_share_bp: 8000 },
      { leg_index: 1, carrier_amount_cents: 9_400, transport_carrier_cents: 7_000, porters_carrier_cents: 2_400, porter_share_kind: "percent", porter_share_bp: 8000 },
    ],
  };
}

async function createOrder(payload: unknown) {
  const { data, error } = await service.rpc("create_order", { p: payload });
  if (error) throw error;
  const order = data as { id: string; order_number: string };
  createdOrders.push(order.id);
  return order;
}

async function countOrders() {
  const { count, error } = await service.from("orders").select("id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

// order_status_history: user sessions may read only these columns (D128: no changed_by / lat / lng) — "*" fails.
const HISTORY_COLUMNS = "id, order_id, from_status, to_status, source, note, created_at";

async function rows(client: SupabaseClient, table: string, orderId?: string) {
  const columns: string = table === "order_status_history" ? HISTORY_COLUMNS : "*";
  let q = client.from(table).select(columns);
  if (orderId) q = q.eq(table === "orders" ? "id" : "order_id", orderId);
  const { data, error } = await q;
  // A table without privileges for the role answers with an error; treat it as "nothing visible".
  return error ? [] : ((data ?? []) as unknown as Record<string, unknown>[]);
}

const check = async (p: PromiseLike<{ error: unknown }>) => {
  const { error } = await p;
  if (error) throw error;
};

beforeAll(async () => {
  [customerA, customerB, blockedCustomer, carrier, otherCarrier, blockedCarrier, admin, blockedAdmin] = await Promise.all([
    createUser({}),
    createUser({}),
    createUser({}),
    createUser({ role: "padroncino" }),
    createUser({ role: "padroncino" }),
    createUser({ role: "padroncino" }),
    createUser({}),
    createUser({}),
  ]);
  await check(service.from("customers").insert([customerA, customerB, blockedCustomer].map((u) => ({ profile_id: u.id, customer_type: "private" }))));
  await check(service.from("carriers").insert([carrier, otherCarrier, blockedCarrier].map((u) => ({ profile_id: u.id, company_name: "Trasporti Test", vat_number: vat(), status: "active" }))));
  await check(service.from("profiles").update({ role: "admin" }).in("id", [admin.id, blockedAdmin.id]));

  const { data: list, error: listError } = await service.from("price_lists").select("id, version").eq("status", "active").single();
  if (listError) throw listError;
  priceList = list;
  const { data: vt, error: vtError } = await service.from("vehicle_types").select("id").eq("is_active", true).order("size_rank").limit(1).single();
  if (vtError) throw vtError;
  vehicleTypeId = vt.id;
  const { data: wh, error: whError } = await service
    .from("warehouses")
    .insert({ name: "Magazzino Test", address: "Via Magazzino 1, Milano", city: "Milano", province: "MI", lat: 45.5, lng: 9.2, is_active: true })
    .select("id")
    .single();
  if (whError) throw whError;
  warehouseId = wh.id;

  orderA = await createOrder(simplePayload(customerA.id));
  orderA2 = await createOrder(storagePayload(customerA.id));
  orderB = await createOrder(simplePayload(customerB.id));
  orderBlocked = await createOrder(simplePayload(blockedCustomer.id));

  // Assignment is a Stage 4 RPC; here the server (service role) sets it directly.
  await check(service.from("orders").update({ carrier_id: carrier.id }).eq("id", orderA.id));
  await check(service.from("orders").update({ carrier_id: blockedCarrier.id }).eq("id", orderBlocked.id));
  await check(service.from("profiles").update({ is_blocked: true }).in("id", [blockedCustomer.id, blockedCarrier.id, blockedAdmin.id]));
});

afterAll(async () => {
  // Local database only (D64). Unpaid orders can be deleted (D77); the snapshot tables cascade.
  if (createdOrders.length) {
    await service.from("orders").update({ status: "pending_payment", paid_at: null, carrier_id: null }).in("id", createdOrders);
    await check(service.from("orders").delete().in("id", createdOrders));
  }
  if (warehouseId) await service.from("warehouses").delete().eq("id", warehouseId);
  await deleteCreatedUsers();
});

describe("anonymous visitors (anon)", () => {
  for (const table of [...ORDER_TABLES, "quotes", "warehouses"]) {
    it(`read nothing from ${table}`, async () => {
      expect(await rows(anon, table)).toEqual([]);
    });
  }

  it("cannot call create_order", async () => {
    const { error } = await anon.rpc("create_order", { p: simplePayload(customerA.id) });
    expect(error).not.toBeNull();
  });
});

describe("cliente", () => {
  it("reads own orders, legs, history, charges and lines", async () => {
    const orders = await rows(customerA.client, "orders");
    expect(orders.map((o) => o.id).sort()).toEqual([orderA.id, orderA2.id].sort());
    for (const table of ["order_legs", "order_status_history", "order_charges", "order_lines"]) {
      const visible = await rows(customerA.client, table);
      expect(visible.length).toBeGreaterThan(0);
      expect(new Set(visible.map((r) => r.order_id))).toEqual(new Set([orderA.id, orderA2.id]));
    }
  });

  it("storage order has two legs with the porters of each leg (D74)", async () => {
    const { data } = await customerA.client.from("order_legs").select("leg_index, porter_package_code, porters_count, porters_included_hours").eq("order_id", orderA2.id).order("leg_index");
    expect(data).toEqual([
      { leg_index: 0, porter_package_code: "bilocale", porters_count: 2, porters_included_hours: 3 },
      { leg_index: 1, porter_package_code: "parcels", porters_count: 1, porters_included_hours: 1 },
    ]);
  });

  it("does not see other customers' orders or any of their rows", async () => {
    for (const table of ORDER_TABLES) {
      const visible = await rows(customerB.client, table);
      expect(visible.every((r) => (table === "orders" ? r.id : r.order_id) === orderB.id)).toBe(true);
      expect(visible.some((r) => [orderA.id, orderA2.id].includes(String(table === "orders" ? r.id : r.order_id)))).toBe(false);
    }
  });

  it("never reads carrier amounts, not even for own orders (D29)", async () => {
    expect(await rows(customerA.client, "order_leg_carrier_terms")).toEqual([]);
  });

  it("cannot insert, update or delete anything — not even own orders", async () => {
    const c = customerA.client;
    const attempts = [
      c.from("orders").update({ status: "paid" }).eq("id", orderA.id),
      c.from("orders").delete().eq("id", orderA.id),
      c.from("orders").insert({ customer_id: customerA.id }),
      c.from("order_charges").update({ total_cents: 1 }).eq("order_id", orderA.id),
      c.from("order_lines").delete().eq("order_id", orderA.id),
      c.from("order_lines").insert(line(9, 0, "transport", 1, 0, "transport")),
      c.from("order_legs").update({ distance_m: 1 }).eq("order_id", orderA.id),
      c.from("order_status_history").insert({ order_id: orderA.id, to_status: "paid", source: "customer_app" }),
      c.from("order_leg_carrier_terms").insert({ order_id: orderA.id, leg_index: 0, carrier_amount_cents: 0 }),
    ];
    for (const attempt of attempts) expect((await attempt).error).not.toBeNull();

    const { data } = await service.from("order_charges").select("total_cents").eq("order_id", orderA.id).single();
    expect(data?.total_cents).toBe(19_520);
    const { data: order } = await service.from("orders").select("status").eq("id", orderA.id).single();
    expect(order?.status).toBe("pending_payment");
  });

  it("cannot call create_order (server only)", async () => {
    const { error } = await customerA.client.rpc("create_order", { p: simplePayload(customerA.id) });
    expect(error).not.toBeNull();
  });
});

describe("padroncino", () => {
  it("without an assignment sees nothing", async () => {
    for (const table of ORDER_TABLES) expect(await rows(otherCarrier.client, table)).toEqual([]);
  });

  // History rows only from the carrier's own assignment on (D128) — orderA is assigned here by a direct update
  // without a history row, so that is covered with real accept/assign flows in carrier-job-history.test.ts.
  it("assigned: reads the order, legs and own carrier amounts", async () => {
    expect((await rows(carrier.client, "orders")).map((o) => o.id)).toEqual([orderA.id]);
    for (const table of ["order_legs"]) {
      const visible = await rows(carrier.client, table);
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((r) => r.order_id === orderA.id)).toBe(true);
    }
    const terms = await rows(carrier.client, "order_leg_carrier_terms");
    expect(terms).toEqual([expect.objectContaining({ order_id: orderA.id, leg_index: 0, carrier_amount_cents: 11_800 })]);
  });

  it("assigned: never reads the customer price (D29)", async () => {
    expect(await rows(carrier.client, "order_charges")).toEqual([]);
    expect(await rows(carrier.client, "order_lines")).toEqual([]);
  });

  it("cannot write anything, not even to the assigned order", async () => {
    const c = carrier.client;
    for (const attempt of [
      c.from("orders").update({ status: "picked_up" }).eq("id", orderA.id),
      c.from("order_legs").update({ porters_worked_minutes: 30 }).eq("order_id", orderA.id),
      c.from("order_leg_carrier_terms").update({ carrier_amount_cents: 99_999 }).eq("order_id", orderA.id),
      c.from("order_status_history").insert({ order_id: orderA.id, to_status: "picked_up", source: "carrier_app" }),
    ]) {
      expect((await attempt).error).not.toBeNull();
    }
    const { data } = await service.from("order_leg_carrier_terms").select("carrier_amount_cents").eq("order_id", orderA.id).single();
    expect(data?.carrier_amount_cents).toBe(11_800);
  });

  it("cannot call create_order", async () => {
    expect((await carrier.client.rpc("create_order", { p: simplePayload(customerA.id) })).error).not.toBeNull();
  });

  // D115: a suspended carrier keeps the jobs already assigned to it and sees no other order.
  // TODO (step "Accetta la Corsa"): the list of available jobs and accepting refuse a suspended carrier — test there.
  it("suspended: still reads its assigned order, sees no unassigned or other carriers' orders", async () => {
    const suspended = await createUser({ role: "padroncino" });
    await check(service.from("carriers").insert({ profile_id: suspended.id, company_name: "Trasporti Sospesi", vat_number: vat(), status: "suspended", status_reason: "Controllo" }));
    const order = await createOrder(simplePayload(customerB.id));
    await check(service.from("orders").update({ carrier_id: suspended.id }).eq("id", order.id));

    expect((await rows(suspended.client, "orders")).map((o) => o.id)).toEqual([order.id]);
    const terms = await rows(suspended.client, "order_leg_carrier_terms");
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.every((t) => t.order_id === order.id)).toBe(true);
    for (const table of ["order_charges", "order_lines"]) expect(await rows(suspended.client, table)).toEqual([]);
  });
});

describe("admin", () => {
  it("reads every order table", async () => {
    // Per order: a whole-table read stops at max_rows (1000) once other test files have created many orders.
    for (const table of ORDER_TABLES) {
      for (const o of [orderA, orderA2, orderB, orderBlocked]) expect((await rows(admin.client, table, o.id)).length, `${table} ${o.id}`).toBeGreaterThan(0);
    }
  });

  it("does not write directly (changes go through the server)", async () => {
    const a = admin.client;
    for (const attempt of [
      a.from("orders").update({ status: "cancelled" }).eq("id", orderB.id),
      a.from("order_charges").update({ refunded_cents: 100 }).eq("order_id", orderB.id),
      a.from("order_lines").delete().eq("order_id", orderB.id),
    ]) {
      expect((await attempt).error).not.toBeNull();
    }
    expect((await a.rpc("create_order", { p: simplePayload(customerB.id) })).error).not.toBeNull();
  });
});

describe("blocked accounts", () => {
  it("blocked customer, carrier and admin read nothing — not even their own / assigned order", async () => {
    for (const user of [blockedCustomer, blockedCarrier, blockedAdmin]) {
      for (const table of ORDER_TABLES) expect(await rows(user.client, table)).toEqual([]);
    }
  });

  it("create_order refuses a blocked customer", async () => {
    const { error } = await service.rpc("create_order", { p: simplePayload(blockedCustomer.id) });
    expect(error?.message).toMatch(/customer not found or blocked/);
  });
});

describe("quotes — server only (D76)", () => {
  it("no browser role can read or write quotes; the server can", async () => {
    const quote = {
      price_list_id: priceList.id,
      customer_type: "private",
      input: { legs: [] },
      quote: { carrierAmountCents: 11_800 },
      valid_until: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    const { data, error } = await service.from("quotes").insert(quote).select("id").single();
    expect(error).toBeNull();
    for (const user of [customerA, carrier, admin]) {
      expect(await rows(user.client, "quotes")).toEqual([]);
      expect((await user.client.from("quotes").insert(quote)).error).not.toBeNull();
    }
    expect((await anon.from("quotes").insert(quote)).error).not.toBeNull();
    expect((await service.from("quotes").update({ customer_type: "business" }).eq("id", data!.id)).error).not.toBeNull();
    await check(service.from("quotes").delete().eq("id", data!.id));
  });
});

describe("create_order (D71, D77)", () => {
  it("assigns TG-YYYY-NNNNNN numbers that grow, and writes the first history row", async () => {
    const year = new Intl.DateTimeFormat("en", { timeZone: "Europe/Rome", year: "numeric" }).format(new Date());
    const numbers = [orderA, orderA2, orderB].map((o) => o.order_number);
    for (const n of numbers) expect(n).toMatch(new RegExp(`^TG-${year}-\\d{6}$`));
    expect([...numbers].sort()).toEqual(numbers);
    expect(new Set(numbers).size).toBe(3);

    const { data } = await service.from("order_status_history").select("from_status, to_status, source, changed_by").eq("order_id", orderB.id);
    expect(data).toEqual([{ from_status: null, to_status: "pending_payment", source: "customer_app", changed_by: customerB.id }]);
    const { data: order } = await service.from("orders").select("status, pickup_window_start").eq("id", orderB.id).single();
    expect(order).toEqual({ status: "pending_payment", pickup_window_start: "2026-12-01T09:00:00+00:00" });
  });

  it("the server cannot insert orders or snapshot rows directly — only through create_order", async () => {
    expect((await service.from("orders").insert({ customer_id: customerA.id })).error).not.toBeNull();
    expect((await service.from("order_lines").insert({ order_id: orderA.id, ...line(9, 0, "transport", 1, 0, "transport") })).error).not.toBeNull();
    expect((await service.from("order_status_history").insert({ order_id: orderA.id, to_status: "paid", source: "system_job" })).error).not.toBeNull();
  });

  const invalidCases: [string, (p: ReturnType<typeof storagePayload>) => unknown, RegExp][] = [
    ["storage order with one leg", (p) => ({ ...p, legs: [p.legs[0]], carrier_terms: [p.carrier_terms[0]] }), /exactly 2 legs/],
    ["two legs without storage", (p) => ({ ...p, storage: null }), /exactly 2 legs/],
    ["line totals different from the charges", (p) => ({ ...p, charges: { ...p.charges, subtotal_cents: 1, total_cents: 1 + p.charges.vat_cents } }), /line totals/],
    ["porters on a leg without a porters line (D74)", (p) => ({ ...p, lines: p.lines.filter((l) => !(l.line_type === "porters" && l.leg_index === 1)), charges: { ...p.charges, subtotal_cents: 41_500, vat_cents: 9_130, total_cents: 50_630 } }), /porters of a leg/],
    ["second leg leaves from the customer instead of the warehouse", (p) => ({ ...p, legs: [p.legs[0], { ...p.legs[1], pickup_warehouse_id: null }] }), /A→warehouse/],
    ["carrier terms missing for a leg", (p) => ({ ...p, carrier_terms: [p.carrier_terms[0]] }), /every leg/],
    ["carrier amount different from its groups", (p) => ({ ...p, carrier_terms: [{ ...p.carrier_terms[0], carrier_amount_cents: 1 }, p.carrier_terms[1]] }), /check constraint/],
    ["storage without pallets for pallet_day", (p) => ({ ...p, storage: { ...p.storage, storage_pallets: null } }), /check constraint/],
  ];
  for (const [label, mutate, message] of invalidCases) {
    it(`rejects ${label} and leaves nothing behind`, async () => {
      const before = await countOrders();
      const { error } = await service.rpc("create_order", { p: mutate(storagePayload(customerA.id)) });
      expect(error?.message).toMatch(message);
      expect(await countOrders()).toBe(before);
    });
  }
});

describe("snapshot is immutable (D77)", () => {
  it("the server cannot change price lines, legs, carrier terms or the price in order_charges", async () => {
    for (const attempt of [
      service.from("order_lines").update({ net_cents: 1 }).eq("order_id", orderA.id),
      service.from("order_lines").delete().eq("order_id", orderA.id),
      service.from("order_legs").update({ distance_m: 1 }).eq("order_id", orderA.id),
      service.from("order_leg_carrier_terms").update({ carrier_amount_cents: 1 }).eq("order_id", orderA.id),
      service.from("order_charges").update({ total_cents: 1 }).eq("order_id", orderA.id),
      service.from("orders").update({ customer_id: customerB.id }).eq("id", orderA.id),
      service.from("orders").update({ order_number: "TG-0000-000000" }).eq("id", orderA.id),
    ]) {
      expect((await attempt).error).not.toBeNull();
    }
    const { data } = await service.from("order_lines").select("net_cents").eq("order_id", orderA.id).order("sort_order");
    expect(data?.map((l) => l.net_cents)).toEqual([10_000, 6_000]);
  });

  it("refunded_cents is the only mutable amount, within 0..total", async () => {
    expect((await service.from("order_charges").update({ refunded_cents: 500 }).eq("order_id", orderB.id)).error).toBeNull();
    expect((await service.from("order_charges").update({ refunded_cents: 999_999 }).eq("order_id", orderB.id)).error).not.toBeNull();
    await check(service.from("order_charges").update({ refunded_cents: 0 }).eq("order_id", orderB.id));
  });

  it("status history is append-only, also for the server", async () => {
    expect((await service.from("order_status_history").update({ note: "x" }).eq("order_id", orderA.id)).error).not.toBeNull();
    expect((await service.from("order_status_history").delete().eq("order_id", orderA.id)).error).not.toBeNull();
    const { count } = await service.from("order_status_history").select("id", { count: "exact", head: true }).eq("order_id", orderA.id);
    expect(count).toBe(1);
  });

  it("a later price list does not change existing orders", async () => {
    const before = await service.from("order_lines").select("net_cents, vat_cents, gross_cents").eq("order_id", orderA2.id).order("sort_order");
    const { data: draftId, error } = await admin.client.rpc("clone_price_list", { p_source_id: priceList.id });
    expect(error).toBeNull();
    await check(admin.client.from("price_list_vehicle_rates").update({ rate_per_km_cents: 999 }).eq("price_list_id", draftId as string));
    await check(admin.client.rpc("publish_price_list", { p_price_list_id: draftId as string }));

    const { data: charges } = await service.from("order_charges").select("price_list_id, price_list_version, total_cents").eq("order_id", orderA2.id).single();
    expect(charges).toEqual({ price_list_id: priceList.id, price_list_version: priceList.version, total_cents: 54_290 });
    const after = await service.from("order_lines").select("net_cents, vat_cents, gross_cents").eq("order_id", orderA2.id).order("sort_order");
    expect(after.data).toEqual(before.data);
    // The old price list is now archived and still referenced; it cannot be deleted.
    expect((await service.from("price_lists").delete().eq("id", priceList.id)).error).not.toBeNull();
  });
});

describe("deleting (D77)", () => {
  it("a paid order cannot be deleted, not even by the server", async () => {
    await check(service.from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", orderB.id));
    expect((await service.from("orders").delete().eq("id", orderB.id)).error?.message).toMatch(/Only unpaid orders/);
    await check(service.from("orders").update({ status: "pending_payment", paid_at: null }).eq("id", orderB.id));
  });

  it("an unpaid order can be deleted by the server and takes its snapshot rows with it", async () => {
    const extra = await createOrder(simplePayload(customerB.id));
    await check(service.from("orders").delete().eq("id", extra.id));
    for (const table of ORDER_TABLES) {
      const { data } = await service.from(table).select("*").eq(table === "orders" ? "id" : "order_id", extra.id);
      expect(data).toEqual([]);
    }
  });

  it("a customer account with orders cannot be deleted (GDPR = anonymisation, D35)", async () => {
    const { error } = await service.auth.admin.deleteUser(customerB.id);
    expect(error).not.toBeNull();
    const { data } = await service.from("profiles").select("id").eq("id", customerB.id);
    expect(data).toHaveLength(1);
  });

  it("status checks: paid needs paid_at, assigned needs a carrier", async () => {
    expect((await service.from("orders").update({ status: "paid" }).eq("id", orderB.id)).error).not.toBeNull();
    expect((await service.from("orders").update({ status: "assigned", paid_at: new Date().toISOString() }).eq("id", orderB.id)).error).not.toBeNull();
  });
});

describe("warehouses (D72) — admin only", () => {
  it("customer, carrier and blocked admin read nothing; admin reads and edits", async () => {
    for (const user of [customerA, carrier, blockedAdmin]) {
      expect(await rows(user.client, "warehouses")).toEqual([]);
      expect((await user.client.from("warehouses").update({ name: "X" }).eq("id", warehouseId).select()).data ?? []).toEqual([]);
    }
    expect((await customerA.client.from("warehouses").insert({ name: "X", address: "Y", city: "Milano", province: "MI", lat: 1, lng: 1 })).error).not.toBeNull();

    expect((await rows(admin.client, "warehouses")).map((w) => w.id)).toContain(warehouseId);
    const { data } = await admin.client.from("warehouses").update({ name: "Magazzino Milano" }).eq("id", warehouseId).select("name");
    expect(data).toEqual([{ name: "Magazzino Milano" }]);
  });

  it("at most one active warehouse in the MVP", async () => {
    const { error } = await admin.client.from("warehouses").insert({ name: "Secondo", address: "Via 2", city: "Milano", province: "MI", lat: 1, lng: 1, is_active: true });
    expect(error).not.toBeNull();
  });

  it("a warehouse used by an order cannot be deleted", async () => {
    expect((await admin.client.from("warehouses").delete().eq("id", warehouseId)).error).not.toBeNull();
  });
});

describe("payload from the booking code is accepted by create_order (TS ↔ SQL)", () => {
  it("storage order with porters on both legs, built by the engine and buildOrderPayload", async () => {
    const A: Endpoint = { address: "Via Roma 1, Milano", placeId: "place-a", lat: 45.46, lng: 9.19, city: "Milano", postalCode: "20121", province: "MI", warehouseId: null };
    const B: Endpoint = { address: "Via Po 2, Torino", placeId: "place-b", lat: 45.07, lng: 7.69, city: "Torino", postalCode: "10124", province: "TO", warehouseId: null };
    const state: WizardState = {
      ...EMPTY_WIZARD_STATE,
      pickup: { placeId: "place-aaaaaaaaaa", label: "A", floor: 2, hasElevator: false },
      delivery: { placeId: "place-bbbbbbbbbb", label: "B", floor: 0, hasElevator: true },
      pickupDate: "2026-12-01",
      pickupWindow: "10-12",
      goods: { ...EMPTY_WIZARD_STATE.goods, description: "Trasloco bilocale", itemsCount: 30, loadCategory: "bilocale", largestItem: { lengthCm: 220, widthCm: 90, heightCm: 85 }, palletsCount: 2 },
      portersPickup: { packageCode: "bilocale" },
      portersDelivery: { packageCode: "monolocale", count: 3 },
      packingItems: 4,
      storage: { returnDate: "2026-12-20", returnWindow: "14-16", pallets: 2 },
      vehicleTypeId,
    };
    const plan = planLegs(state, A, B, { id: warehouseId, address: "Via Magazzino 1, Milano", placeId: null, lat: 45.5, lng: 9.2, city: "Milano", postalCode: null, province: "MI" });
    if (!plan.ok) throw new Error(plan.error);
    const legs = plan.legs.map((l, i) => ({ ...l, distanceM: [12_000, 150_000][i], durationS: 1800 }));
    const config = makeConfig({ priceListId: priceList.id, priceListVersion: priceList.version, vehicleRates: [{ vehicleTypeId, nameIt: "Furgone", ratePerKmCents: 140, minPriceCents: 6000 }] });
    const now = new Date("2026-11-20T08:00:00Z");
    const result = calculatePrice(priceInputFor({ state, legs, storageDays: plan.storageDays, storageBillingUnit: "pallet_day", vehicleTypeId, customerType: "private", now }), config);
    if (!result.ok) throw new Error(JSON.stringify(result.error));

    const payload = buildOrderPayload({
      customerId: customerA.id, state, vehicleTypeId, legs, storageDays: plan.storageDays, storageBillingUnit: "pallet_day",
      quote: result.quote, quotedAt: now, termsVersion: "2026-11-01", termsAcceptedAt: now,
      contacts: { pickupName: "Mario", pickupPhone: "+393331234567", deliveryName: "Lucia", deliveryPhone: "+393337654321", notes: "" },
      billingDetails: { customer_type: "private", fiscal_code: "RSSMRA80A01F205X" },
    });
    const order = await createOrder(payload);

    const { data: charges } = await service.from("order_charges").select("total_cents").eq("order_id", order.id).single();
    expect(charges?.total_cents).toBe(result.quote.totalCents);
    const { data: terms } = await service.from("order_leg_carrier_terms").select("leg_index, carrier_amount_cents").eq("order_id", order.id).order("leg_index");
    expect(terms?.map((t) => t.carrier_amount_cents)).toEqual(result.quote.carrierAmountByLegCents);
    const { data: legRows } = await service.from("order_legs").select("leg_index, porters_count, porters_included_hours").eq("order_id", order.id).order("leg_index");
    expect(legRows).toEqual([
      { leg_index: 0, porters_count: 2, porters_included_hours: 3 },
      { leg_index: 1, porters_count: 3, porters_included_hours: 2 },
    ]);
  });
});
