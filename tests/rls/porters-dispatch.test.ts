import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, localSql, service, type TestUser } from "./helpers";
import { HOUR, PAST, accept, activeCarrier, check, history, listedIds, paidOrder, release, run, setupJobContext, teardownJobContext, type DbError } from "./job-fixtures";

// Step 6a of docs/plany/tre-servizi.md — Facchinaggio dispatch (D152, D164–D168), migration porters_dispatch:
// list_available_porter_jobs / accept_porter_job (carrier session), admin_porter_candidates /
// admin_assign_porter_job / admin_set_carrier_porters (service role), admin_advance_order per service type.
// LOCAL database only (D64).

let admin: TestUser;
let customer: TestUser;
let priceList: { id: string; version: number };

const AREA = "BO"; // activated for this file only

type Carrier = Awaited<ReturnType<typeof activeCarrier>>;
type JobRow = Record<string, unknown> & { order_id: string };

const line = (sort: number, type: string, net: number) => {
  const vatCents = Math.round((net * 22) / 100);
  return { sort_order: sort, leg_index: 0, line_type: type, label_it: `Voce ${sort}`, quantity: 1, unit_amount_cents: net, net_cents: net, vat_cents: vatCents, gross_cents: net + vatCents, carrier_share_group: "porters" };
};

/** A paid porters order (create_service_order + the payment functions, as in production). */
async function paidPorters(o: { persons?: number; hoursAhead?: number } = {}): Promise<string> {
  const persons = o.persons ?? 2;
  const start = new Date(Date.now() + (o.hoursAhead ?? 72) * HOUR);
  start.setUTCMinutes(0, 0, 0);
  const lines = [line(0, "porters", persons * 2 * 3_000), line(1, "porters_floors", 3_000)];
  const net = lines.reduce((s, l) => s + l.net_cents, 0);
  const vatCents = lines.reduce((s, l) => s + l.vat_cents, 0);
  const p = {
    service_type: "porters", customer_id: customer.id,
    goods_description: "Armadio di Mario Rossi e 10 scatoloni", customer_notes: "Citofono Rossi, scala B",
    site_contact_name: "Mario Rossi", site_contact_phone: "+393331234567",
    porter_job: {
      address: "Via dell'Indipendenza 10, 40121 Bologna BO", place_id: "place-porters", lat: 44.4990, lng: 11.3430,
      city: "Bologna", postal_code: "40121", province: AREA,
      job_date: start.toISOString().slice(0, 10), window_start: start.toISOString(), window_end: new Date(start.getTime() + 2 * HOUR).toISOString(),
      floor: 3, has_elevator: false, persons, requested_hours: 2, billed_hours: 2, is_urgent: false, overtime_grace_minutes: 15,
    },
    charges: {
      price_list_id: priceList.id, price_list_version: priceList.version, customer_type: "private", vat_rate_bp: 2200,
      subtotal_cents: net, vat_cents: vatCents, total_cents: net + vatCents, porter_overtime_rate_cents: 3_500,
      billing_details: { first_name: "Mario", last_name: "Rossi", fiscal_code: "RSSMRA80A01F205X", street: "Via Roma 1", city: "Bologna", postal_code: "40121", province: AREA },
      terms_accepted_at: new Date().toISOString(), terms_version: "2026-11-01", quoted_at: new Date().toISOString(),
    },
    lines,
    porter_terms: { carrier_amount_cents: 9_600, porter_share_kind: "percent", porter_share_bp: 8000, porter_share_carrier_cents: null, porter_share_net_cents: null },
  };
  const order = (await check(service.rpc("create_service_order", { p }))) as { id: string };
  const session = `cs_test_${randomUUID()}`;
  await run(service.rpc("start_order_payment", { p_order_id: order.id, p_session_id: session, p_amount_cents: net + vatCents, p_expires_at: new Date(Date.now() + HOUR).toISOString() }));
  await run(service.rpc("confirm_order_payment", { p_session_id: session, p_payment_intent_id: `pi_${randomUUID()}`, p_charge_id: `ch_${randomUUID()}`, p_amount_cents: net + vatCents, p_currency: "eur" }));
  return order.id;
}

const setPorters = (carrierId: string, offers: boolean, team: number | null) =>
  service.rpc("admin_set_carrier_porters", { p_carrier_id: carrierId, p_admin_id: admin.id, p_offers: offers, p_team_size: team })
    .single<{ jobs_in_progress: number; jobs_team_too_small: number }>();

/** An active carrier that offers facchinaggio with the given team. */
async function portersCarrier(team = 2): Promise<Carrier> {
  const c = await activeCarrier();
  await run(setPorters(c.user.id, true, team));
  return c;
}

const listPorters = async (c: TestUser, orderId?: string) => {
  const { data, error } = await c.client.rpc("list_available_porter_jobs", orderId ? { p_order_id: orderId } : {});
  return { rows: (data ?? []) as JobRow[], error: error as DbError };
};
const porterIds = async (c: TestUser) => {
  const { rows, error } = await listPorters(c);
  if (error) throw error;
  return rows.map((r) => r.order_id);
};
const acceptPorters = (c: TestUser, orderId: string) =>
  c.client.rpc("accept_porter_job", { p_order_id: orderId }).single<{ assigned_at: string; newly_assigned: boolean }>();
const candidates = async (orderId: string) =>
  (await check(service.rpc("admin_porter_candidates", { p_order_id: orderId, p_admin_id: admin.id }))) as { carrier_id: string; company_name: string; porters_team_size: number }[];
const assign = (orderId: string, carrierId: string) =>
  service.rpc("admin_assign_porter_job", { p_order_id: orderId, p_carrier_id: carrierId, p_admin_id: admin.id });
const advance = (orderId: string, to: string, note: string | null = null) =>
  service.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: admin.id, p_to_status: to, p_note: note });
const order = (id: string) => check(service.from("orders").select("status, carrier_id, carrier_vehicle_id, assigned_at, picked_up_at, in_transit_at, delivered_at, delivered_without_pod").eq("id", id).single());
const expectError = (error: unknown, code: string, details?: string) => {
  expect((error as DbError)?.code, (error as DbError)?.message).toBe(code);
  if (details !== undefined) expect((error as DbError)?.details).toBe(details);
};

beforeAll(async () => {
  ({ admin, customer } = await setupJobContext());
  priceList = await check(service.from("price_lists").select("id, version").eq("status", "active").single());
  await run(service.from("service_area_provinces").update({ is_active: true }).eq("province_code", AREA));
});

afterAll(async () => {
  await service.from("service_area_provinces").update({ is_active: false }).eq("province_code", AREA);
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("who may call the functions", () => {
  it("admin functions: only the service role — anon, cliente, padroncino, admin session (even with the admin's own id) are refused", async () => {
    const orderId = await paidPorters();
    const c = await portersCarrier();
    const blockedAdmin = await createUser({});
    await run(service.from("profiles").update({ role: "admin" }).eq("id", blockedAdmin.id));
    await run(service.from("profiles").update({ is_blocked: true }).eq("id", blockedAdmin.id));
    for (const client of [anon, customer.client, c.user.client, admin.client, blockedAdmin.client]) {
      expect((await client.rpc("admin_porter_candidates", { p_order_id: orderId, p_admin_id: admin.id })).error).not.toBeNull();
      expect((await client.rpc("admin_assign_porter_job", { p_order_id: orderId, p_carrier_id: c.user.id, p_admin_id: admin.id })).error).not.toBeNull();
      expect((await client.rpc("admin_set_carrier_porters", { p_carrier_id: c.user.id, p_admin_id: admin.id, p_offers: true, p_team_size: 4 })).error).not.toBeNull();
      expect((await client.rpc("carrier_fits_porter_job", { p_carrier_id: c.user.id, p_order_id: orderId })).error).not.toBeNull();
    }
    expect(await order(orderId)).toMatchObject({ status: "paid", carrier_id: null });
    expect((await check(service.from("carriers").select("porters_team_size").eq("profile_id", c.user.id).single())).porters_team_size).toBe(2);
  });

  it("service role with a non-admin or blocked admin id → 42501", async () => {
    const orderId = await paidPorters();
    const c = await portersCarrier();
    const blockedAdmin = await createUser({});
    await run(service.from("profiles").update({ role: "admin", is_blocked: true }).eq("id", blockedAdmin.id));
    for (const fakeAdmin of [customer.id, c.user.id, blockedAdmin.id, randomUUID()]) {
      expectError((await service.rpc("admin_porter_candidates", { p_order_id: orderId, p_admin_id: fakeAdmin })).error, "42501");
      expectError((await service.rpc("admin_assign_porter_job", { p_order_id: orderId, p_carrier_id: c.user.id, p_admin_id: fakeAdmin })).error, "42501");
      expectError((await service.rpc("admin_set_carrier_porters", { p_carrier_id: c.user.id, p_admin_id: fakeAdmin, p_offers: false, p_team_size: null })).error, "42501");
    }
    expect(await order(orderId)).toMatchObject({ status: "paid", carrier_id: null });
  });

  it("carrier functions: only a carrier session (anon, cliente and admin are refused)", async () => {
    const orderId = await paidPorters();
    for (const client of [anon, customer.client, admin.client]) {
      expect((await client.rpc("list_available_porter_jobs", {})).error).not.toBeNull();
      expect((await client.rpc("accept_porter_job", { p_order_id: orderId })).error).not.toBeNull();
    }
    expect(await order(orderId)).toMatchObject({ status: "paid", carrier_id: null });
  });
});

describe("list_available_porter_jobs", () => {
  it("anonymised card: no street, postal code, coordinates, contact, goods or notes; the carrier's own amount only", async () => {
    const orderId = await paidPorters();
    const c = await portersCarrier();
    const { rows, error } = await listPorters(c.user, orderId);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([
      "billed_hours", "carrier_amount_cents", "city", "floor", "has_elevator", "is_urgent", "job_date", "order_id",
      "order_number", "persons", "province", "requested_hours", "window_end", "window_start",
    ]);
    expect(rows[0]).toMatchObject({ city: "Bologna", province: AREA, persons: 2, billed_hours: 2, floor: 3, has_elevator: false, carrier_amount_cents: 9_600 });
    const text = JSON.stringify(rows);
    for (const secret of ["Indipendenza", "40121", "44.49", "Rossi", "+39", "Armadio", "Citofono", "place-porters"]) expect(text).not.toContain(secret);
  });

  it("before accepting the carrier cannot read the address or the contact; after accepting it can (RLS)", async () => {
    const orderId = await paidPorters();
    const c = await portersCarrier();
    expect((await check(c.user.client.from("order_porter_jobs").select("address").eq("order_id", orderId)))).toEqual([]);
    expect((await check(c.user.client.from("orders").select("pickup_contact_phone").eq("id", orderId)))).toEqual([]);
    await run(acceptPorters(c.user, orderId));
    expect((await check(c.user.client.from("order_porter_jobs").select("address").eq("order_id", orderId).single())).address).toMatch(/Indipendenza/);
    expect((await check(c.user.client.from("orders").select("pickup_contact_phone").eq("id", orderId).single())).pickup_contact_phone).toBe("+393331234567");
    expect((await check(c.user.client.from("order_porter_carrier_terms").select("carrier_amount_cents").eq("order_id", orderId).single())).carrier_amount_cents).toBe(9_600);
  });

  it("only carriers offering facchinaggio with a team ≥ persons; transport carriers get an empty list", async () => {
    const small = await paidPorters({ persons: 2 });
    const big = await paidPorters({ persons: 4 });
    const [none, team2, team4] = await Promise.all([activeCarrier(), portersCarrier(2), portersCarrier(4)]);
    expect(await porterIds(none.user)).toEqual([]);
    expect(await porterIds(team2.user)).toContain(small);
    expect(await porterIds(team2.user)).not.toContain(big);
    expect(await porterIds(team4.user)).toEqual(expect.arrayContaining([small, big]));
  });

  it("not listed once assigned; transport not in the porter list and porters not in the transport list", async () => {
    const transport = await paidOrder();
    const c = await portersCarrier(4);
    const porters = await paidPorters();
    expect(await porterIds(c.user)).toContain(porters);
    expect(await porterIds(c.user)).not.toContain(transport);
    expect(await listedIds(c.user)).not.toContain(porters);
    expect(await listedIds(c.user)).toContain(transport);
    await run(acceptPorters(c.user, porters));
    expect(await porterIds(c.user)).not.toContain(porters);
  });

  it("blockers as list_available_jobs: suspended carrier and expired document → 42501 with the codes", async () => {
    const suspended = await portersCarrier();
    await run(service.rpc("set_carrier_suspension", { p_carrier_id: suspended.user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "Controllo" }));
    expectError((await listPorters(suspended.user)).error, "42501", "carrier_not_active");

    const expired = await portersCarrier();
    await run(service.from("carrier_documents").update({ expires_at: PAST }).eq("carrier_id", expired.user.id).eq("doc_type", "driving_license"));
    expectError((await listPorters(expired.user)).error, "42501", "document:driving_license");

    const orderId = await paidPorters();
    expectError((await acceptPorters(suspended.user, orderId)).error, "42501", "carrier_not_active");
    expectError((await acceptPorters(expired.user, orderId)).error, "42501", "document:driving_license");
    expect((await candidates(orderId)).map((r) => r.carrier_id)).not.toEqual(expect.arrayContaining([suspended.user.id]));
    expect((await candidates(orderId)).map((r) => r.carrier_id)).not.toContain(expired.user.id);
    expect(await order(orderId)).toMatchObject({ status: "paid", carrier_id: null });
  });
});

describe("accept_porter_job", () => {
  it("assigns without a vehicle, writes the history; a second call is a no-op", async () => {
    const orderId = await paidPorters();
    const c = await portersCarrier();
    const first = await check(acceptPorters(c.user, orderId));
    expect(first.newly_assigned).toBe(true);
    expect(await order(orderId)).toMatchObject({ status: "assigned", carrier_id: c.user.id, carrier_vehicle_id: null });
    const again = await check(acceptPorters(c.user, orderId));
    expect(again).toEqual({ assigned_at: first.assigned_at, newly_assigned: false });
    expect(await history(orderId)).toEqual([
      { from_status: null, to_status: "pending_payment", changed_by: customer.id, source: "customer_app" },
      expect.objectContaining({ to_status: "paid" }),
      { from_status: "paid", to_status: "assigned", changed_by: c.user.id, source: "carrier_app" },
    ]);
  });

  it("team too small, carrier without facchinaggio → team_not_suitable; transport and storage orders → 22023", async () => {
    const big = await paidPorters({ persons: 3 });
    const [team2, none] = await Promise.all([portersCarrier(2), activeCarrier()]);
    expectError((await acceptPorters(team2.user, big)).error, "55000", "team_not_suitable");
    expectError((await acceptPorters(none.user, big)).error, "55000", "team_not_suitable");
    const transport = await paidOrder();
    expectError((await acceptPorters(team2.user, transport)).error, "22023", "order");
    expectError((await acceptPorters(team2.user, randomUUID())).error, "22023", "order");
    expect(await order(big)).toMatchObject({ status: "paid", carrier_id: null });
    expect(await order(transport)).toMatchObject({ status: "paid", carrier_id: null });
  });

  it("window already started → too_late", async () => {
    const orderId = await paidPorters();
    const c = await portersCarrier();
    // move the window into the past (test-only; triggers would forbid it)
    expect(localSql(`set session_replication_role = replica; update public.orders set pickup_window_start = now() - interval '1 minute' where id = '${orderId}';`).ok).toBe(true);
    expectError((await acceptPorters(c.user, orderId)).error, "55000", "too_late");
    expect(await porterIds(c.user)).not.toContain(orderId);
    expect(await candidates(orderId)).toEqual([]);
  });

  it("the vehicle path refuses porters: accept_job with a vehicle → vehicle_not_suitable; admin_job_candidates empty", async () => {
    const orderId = await paidPorters();
    const c = await portersCarrier();
    expectError((await accept(c.user, orderId, c.vehicleId)).error, "55000", "vehicle_not_suitable");
    expect(await check(service.rpc("admin_job_candidates", { p_order_id: orderId, p_admin_id: admin.id }))).toEqual([]);
    expectError((await service.rpc("admin_assign_job", { p_order_id: orderId, p_carrier_id: c.user.id, p_vehicle_id: c.vehicleId, p_admin_id: admin.id })).error, "55000", "vehicle_not_suitable");
    expect(await order(orderId)).toMatchObject({ status: "paid", carrier_id: null });
  });

  it.each([2, 5])("race of %i carriers: exactly one wins, the others get already_taken", async (n) => {
    const orderId = await paidPorters();
    const carriers = await Promise.all(Array.from({ length: n }, () => portersCarrier(2)));
    const results = await Promise.all(carriers.map((c) => acceptPorters(c.user, orderId)));
    const winners = results.filter((r) => !r.error);
    expect(winners).toHaveLength(1);
    for (const r of results.filter((x) => x.error)) expectError(r.error, "55000", "already_taken");
    const winner = carriers[results.findIndex((r) => !r.error)];
    expect(await order(orderId)).toMatchObject({ status: "assigned", carrier_id: winner.user.id });
    expect((await history(orderId)).filter((h) => h.to_status === "assigned")).toHaveLength(1);
  });

  it("race carrier vs admin: one assignment only", async () => {
    const orderId = await paidPorters();
    const [a, b] = await Promise.all([portersCarrier(), portersCarrier()]);
    const [byCarrier, byAdmin] = await Promise.all([acceptPorters(a.user, orderId), assign(orderId, b.user.id)]);
    expect([byCarrier.error, byAdmin.error].filter((e) => e === null)).toHaveLength(1);
    expect((await history(orderId)).filter((h) => h.to_status === "assigned")).toHaveLength(1);
  });
});

describe("admin: candidates and assignment", () => {
  it("candidates: active, offering facchinaggio, team ≥ persons, without blockers", async () => {
    const orderId = await paidPorters({ persons: 3 });
    const [ok3, ok4, small, none, suspended] = await Promise.all([portersCarrier(3), portersCarrier(4), portersCarrier(2), activeCarrier(), portersCarrier(4)]);
    await run(service.rpc("set_carrier_suspension", { p_carrier_id: suspended.user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "Controllo" }));
    const ids = (await candidates(orderId)).map((r) => r.carrier_id);
    expect(ids).toEqual(expect.arrayContaining([ok3.user.id, ok4.user.id]));
    for (const id of [small.user.id, none.user.id, suspended.user.id]) expect(ids).not.toContain(id);
    expect((await candidates(orderId)).find((r) => r.carrier_id === ok4.user.id)?.porters_team_size).toBe(4);
  });

  it("assign: paid → assigned without a vehicle, history and audit (ids only)", async () => {
    const orderId = await paidPorters();
    const c = await portersCarrier();
    await run(assign(orderId, c.user.id));
    expect(await order(orderId)).toMatchObject({ status: "assigned", carrier_id: c.user.id, carrier_vehicle_id: null });
    expect((await history(orderId)).at(-1)).toEqual({ from_status: "paid", to_status: "assigned", changed_by: admin.id, source: "admin_panel" });
    const audit = await check(service.from("audit_log").select("actor_id, action, data").eq("entity_id", orderId).eq("action", "order.assigned").single());
    expect(audit).toEqual({ actor_id: admin.id, action: "order.assigned", data: { carrier_id: c.user.id, vehicle_id: null, service_type: "porters" } });
  });

  it("assign refuses: already taken, team too small, not eligible, not a porter job, not paid", async () => {
    const orderId = await paidPorters({ persons: 3 });
    const [small, ok, suspended] = await Promise.all([portersCarrier(2), portersCarrier(3), portersCarrier(4)]);
    await run(service.rpc("set_carrier_suspension", { p_carrier_id: suspended.user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "Controllo" }));
    expectError((await assign(orderId, small.user.id)).error, "55000", "team_not_suitable");
    expectError((await assign(orderId, suspended.user.id)).error, "55000", "carrier_not_eligible:carrier_not_active");
    expectError((await assign(orderId, randomUUID())).error, "22023", "carrier");
    expectError((await assign(await paidOrder(), ok.user.id)).error, "22023", "order");
    await run(assign(orderId, ok.user.id));
    expectError((await assign(orderId, ok.user.id)).error, "55000", "already_taken");
  });
});

describe("admin_set_carrier_porters", () => {
  it("validation: team 2–4 when offering, null when not", async () => {
    const c = await activeCarrier();
    for (const [offers, team] of [[true, null], [true, 1], [true, 5], [false, 2]] as const) {
      expectError((await setPorters(c.user.id, offers, team)).error, "22023", "team");
    }
    expectError((await setPorters(randomUUID(), true, 2)).error, "22023", "carrier");
    expect(await check(service.from("carriers").select("offers_porters, porters_team_size").eq("profile_id", c.user.id).single())).toEqual({ offers_porters: false, porters_team_size: null });
  });

  it("audit only on a real change, with old and new values", async () => {
    const c = await activeCarrier();
    await run(setPorters(c.user.id, true, 3));
    await run(setPorters(c.user.id, true, 3));
    await run(setPorters(c.user.id, false, null));
    const rows = await check(service.from("audit_log").select("actor_id, actor_email, data").eq("entity_id", c.user.id).eq("action", "carrier.porters_updated").order("id"));
    expect(rows).toHaveLength(2);
    expect(rows[0].actor_id).toBe(admin.id);
    expect(rows[0].actor_email).toBeTruthy();
    expect(rows.map((r) => r.data)).toEqual([
      { from: { offers_porters: false, porters_team_size: null }, to: { offers_porters: true, porters_team_size: 3 } },
      { from: { offers_porters: true, porters_team_size: 3 }, to: { offers_porters: false, porters_team_size: null } },
    ]);
  });

  it("assigned jobs stay with the carrier (D116); counts jobs in progress and those with a team too small", async () => {
    const [p2, p3, p4] = [await paidPorters({ persons: 2 }), await paidPorters({ persons: 3 }), await paidPorters({ persons: 4 })];
    const c = await portersCarrier(4);
    for (const id of [p2, p3, p4]) await run(acceptPorters(c.user, id));
    await run(advance(p4, "picked_up"));

    expect(await check(setPorters(c.user.id, true, 3))).toEqual({ jobs_in_progress: 3, jobs_team_too_small: 1 });
    expect(await check(setPorters(c.user.id, true, 2))).toEqual({ jobs_in_progress: 3, jobs_team_too_small: 2 });
    expect(await check(setPorters(c.user.id, false, null))).toEqual({ jobs_in_progress: 3, jobs_team_too_small: 3 });
    for (const id of [p2, p3, p4]) expect((await order(id)).carrier_id).toBe(c.user.id);
    // ...and the carrier still reads them
    expect((await check(c.user.client.from("order_porter_jobs").select("order_id").in("order_id", [p2, p3, p4]))).length).toBe(3);
    // new jobs: none any more
    const fresh = await paidPorters();
    expect(await porterIds(c.user)).not.toContain(fresh);
    expectError((await acceptPorters(c.user, fresh)).error, "55000", "team_not_suitable");
  });

  it("a carrier cannot call it for itself and cannot change the columns directly", async () => {
    const c = await activeCarrier();
    expect((await c.user.client.rpc("admin_set_carrier_porters", { p_carrier_id: c.user.id, p_admin_id: admin.id, p_offers: true, p_team_size: 4 })).error).not.toBeNull();
    await c.user.client.from("carriers").update({ offers_porters: true, porters_team_size: 4 }).eq("profile_id", c.user.id);
    expect(await check(service.from("carriers").select("offers_porters, porters_team_size").eq("profile_id", c.user.id).single())).toEqual({ offers_porters: false, porters_team_size: null });
  });
});

describe("statuses (D165): porters assigned → picked_up → delivered, transport unchanged", () => {
  it("porters: Lavoro iniziato → Lavoro concluso (reason required, without POD, D123); never in_transit", async () => {
    const orderId = await paidPorters();
    const c = await portersCarrier();
    await run(acceptPorters(c.user, orderId));
    expectError((await advance(orderId, "in_transit")).error, "55000", "assigned");
    expectError((await advance(orderId, "delivered", "x")).error, "55000", "assigned");
    await run(advance(orderId, "picked_up"));
    expectError((await advance(orderId, "in_transit")).error, "55000", "picked_up");
    expectError((await advance(orderId, "delivered")).error, "22023", "note");
    await run(advance(orderId, "delivered", "Lavoro confermato dal cliente al telefono"));
    const o = await order(orderId);
    expect(o).toMatchObject({ status: "delivered", in_transit_at: null, delivered_without_pod: true });
    expect(o.picked_up_at).not.toBeNull();
    expect(o.delivered_at).not.toBeNull();
    expect((await history(orderId)).slice(-2).map((h) => [h.from_status, h.to_status])).toEqual([["assigned", "picked_up"], ["picked_up", "delivered"]]);
    expect((await check(service.from("order_admin_notes").select("kind").eq("order_id", orderId))).map((n) => n.kind)).toEqual(["delivered_without_pod"]);
    // after delivery: the carrier still reads its amount; worked_minutes stays null (D166)
    expect((await check(c.user.client.from("order_porter_carrier_terms").select("carrier_amount_cents").eq("order_id", orderId).single())).carrier_amount_cents).toBe(9_600);
    expect((await check(service.from("order_porter_jobs").select("worked_minutes").eq("order_id", orderId).single())).worked_minutes).toBeNull();
  });

  it("transport cannot skip in_transit", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await run(accept(c.user, orderId, c.vehicleId));
    await run(advance(orderId, "picked_up"));
    expectError((await advance(orderId, "delivered", "x")).error, "55000", "picked_up");
    await run(advance(orderId, "in_transit"));
    await run(advance(orderId, "delivered", "x"));
    expect((await order(orderId)).status).toBe("delivered");
  });

  it("the carrier cannot move a porters job: carrier_record_step (no leg) and complete_delivery refuse", async () => {
    const orderId = await paidPorters();
    const c = await portersCarrier();
    await run(acceptPorters(c.user, orderId));
    expectError((await c.user.client.rpc("carrier_record_step", { p_order_id: orderId, p_leg_index: 0, p_step: "arrived_pickup" })).error, "22023", "leg");
    await run(advance(orderId, "picked_up"));
    expectError((await c.user.client.rpc("complete_delivery", { p_order_id: orderId, p_recipient_name: "Mario", p_signature_path: `${orderId}/${randomUUID()}.png` })).error, "55000", "not_in_progress");
    expect((await order(orderId)).status).toBe("picked_up");
  });
});

describe("release and unassign on porters", () => {
  it("Rinuncia within 15 minutes → back to paid and to the porter list", async () => {
    const orderId = await paidPorters();
    const c = await portersCarrier();
    await run(acceptPorters(c.user, orderId));
    await run(release(c.user, orderId));
    expect(await order(orderId)).toMatchObject({ status: "paid", carrier_id: null, carrier_vehicle_id: null });
    expect(await porterIds(c.user)).toContain(orderId);
  });

  it("Rimuovi padroncino: assigned → paid; after Lavoro iniziato → work_started, nothing changes", async () => {
    const a = await paidPorters();
    const b = await paidPorters();
    const c = await portersCarrier();
    await run(acceptPorters(c.user, a));
    await run(acceptPorters(c.user, b));
    await run(service.rpc("admin_unassign_job", { p_order_id: a, p_admin_id: admin.id, p_reason_code: "padroncino_non_disponibile" }));
    expect(await order(a)).toMatchObject({ status: "paid", carrier_id: null });
    expect((await candidates(a)).map((r) => r.carrier_id)).toContain(c.user.id);

    await run(advance(b, "picked_up"));
    expectError((await service.rpc("admin_unassign_job", { p_order_id: b, p_admin_id: admin.id, p_reason_code: "altro" })).error, "55000", "work_started");
    expect(await check(service.from("orders").select("status, carrier_id, handover_required_at").eq("id", b).single())).toEqual({ status: "picked_up", carrier_id: c.user.id, handover_required_at: null });
  });
});

describe("customer e-mails for Facchinaggio (step 6b): real order shape, texts per service", () => {
  const outbox = async (orderId: string, template: string) =>
    check(service.from("email_outbox").select("subject, text_body").eq("template_code", template).eq("order_id", orderId).order("created_at"));

  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example"));
  afterEach(() => vi.unstubAllEnvs());

  it("order_paid → order_assigned → order_delivered: city, window, team; no vehicle, no street", async () => {
    const { sendOrderPaidEmail } = await import("@/lib/payments/server");
    const { sendOrderAssignedEmail, sendOrderDeliveredEmail } = await import("@/lib/orders/customer-emails");
    const orderId = await paidPorters({ persons: 3 });
    const c = await portersCarrier(3);

    await sendOrderPaidEmail(service, orderId);
    await run(acceptPorters(c.user, orderId));
    await sendOrderAssignedEmail(service, orderId, "https://app.example");
    await run(advance(orderId, "picked_up"));
    await run(advance(orderId, "delivered", "Confermato dal cliente"));
    await sendOrderDeliveredEmail(service, orderId, "https://app.example");

    const [paid] = await outbox(orderId, "order_paid");
    expect(paid.text_body).toContain("Servizio: Facchinaggio a Bologna");
    expect(paid.text_body).toContain("Squadra: 3 facchini, 2 ore");
    expect(paid.text_body).toContain("squadra di facchini");
    const [assigned] = await outbox(orderId, "order_assigned");
    expect(assigned.subject).toMatch(/^Facchini assegnati/);
    expect(assigned.text_body).toContain("Facchini: ");
    expect(assigned.text_body).not.toContain("Veicolo");
    const [delivered] = await outbox(orderId, "order_delivered");
    expect(delivered.subject).toMatch(/^Lavoro concluso/);
    for (const m of [paid, assigned, delivered]) {
      expect(m.text_body).not.toContain("Indipendenza");
      expect(m.text_body).not.toContain("Percorso");
    }
  });

  it("cancellation request: the carrier gets city, team and planned start (no route)", async () => {
    const { sendCancellationRequestEmails } = await import("@/lib/orders/cancellation-server");
    const orderId = await paidPorters();
    const c = await portersCarrier();
    await run(acceptPorters(c.user, orderId));
    await sendCancellationRequestEmails(service, orderId, "https://app.example", "admin-6b@transigo.test");
    const [carrier] = await outbox(orderId, "carrier_job_cancelled");
    expect(carrier.text_body).toContain("Servizio: Facchinaggio a Bologna");
    expect(carrier.text_body).toContain("Inizio lavoro previsto: ");
    const [toAdmin] = await outbox(orderId, "cancellation_requested");
    expect(toAdmin.text_body).toContain("Inizio lavoro previsto: ");
    await service.from("email_outbox").delete().eq("to_address", "admin-6b@transigo.test");
  });
});
