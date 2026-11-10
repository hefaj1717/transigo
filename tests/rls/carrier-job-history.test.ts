import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";
import { accept, activeCarrier, check, paidOrder, release, run, setupJobContext, teardownJobContext } from "./job-fixtures";
import { loadMyJob, loadMyJobs } from "@/lib/carriers/jobs-server";

// Status history and reassigned jobs on the LOCAL database (D64, D128): carrier A accepts and gives the job up
// ("Rinuncia", or the admin removes A with "Rimuovi padroncino"), carrier B accepts it.
//  - A, from then on, reads nothing of the order (an old link to /padroncino/le-mie-corse/[id] shows the
//    "non è più assegnata a te" notice: loadMyJob returns null);
//  - B reads nothing about A: no company, vehicles, documents, audit_log, and in order_status_history only the
//    rows since its own assignment, without changed_by / lat / lng (column grants);
//  - the customer reads every history row of the order, without changed_by;
//  - only admins read the full history (with changed_by) through admin_order_status_history().

let admin: TestUser;
let customer: TestUser;
let otherCustomer: TestUser;
let blockedAdmin: TestUser;

const HISTORY = "id, order_id, from_status, to_status, source, note, created_at";
type History = { id: number; from_status: string | null; to_status: string; source: string; note: string | null; created_at: string };

beforeAll(async () => {
  ({ admin, customer } = await setupJobContext());
  [otherCustomer, blockedAdmin] = await Promise.all([createUser({}), createUser({})]);
  await run(service.from("customers").insert({ profile_id: otherCustomer.id, customer_type: "private" }));
  await run(service.from("profiles").update({ role: "admin" }).eq("id", blockedAdmin.id));
  await run(service.from("profiles").update({ is_blocked: true }).eq("id", blockedAdmin.id));
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

/** Everything a user could still try to read about the order with its own session. */
async function whatCanRead(c: TestUser, orderId: string) {
  const [orders, legs, history, terms] = await Promise.all([
    c.client.from("orders").select("id").eq("id", orderId),
    c.client.from("order_legs").select("order_id").eq("order_id", orderId),
    c.client.from("order_status_history").select(HISTORY).eq("order_id", orderId),
    c.client.from("order_leg_carrier_terms").select("order_id").eq("order_id", orderId),
  ]);
  for (const r of [orders, legs, history, terms]) expect(r.error).toBeNull();
  return { orders: orders.data?.length, legs: legs.data?.length, history: history.data?.length, terms: terms.data?.length };
}
const nothing = { orders: 0, legs: 0, history: 0, terms: 0 };

const historyOf = async (c: TestUser, orderId: string) =>
  (await check(c.client.from("order_status_history").select(HISTORY).eq("order_id", orderId).order("id"))) as History[];
const steps = (rows: Pick<History, "from_status" | "to_status" | "source">[]) => rows.map((r) => `${r.from_status ?? "∅"}→${r.to_status}:${r.source}`);
const advance = (orderId: string, to: string) =>
  run(service.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: admin.id, p_to_status: to }));

type Scenario = { orderId: string; a: Awaited<ReturnType<typeof activeCarrier>>; b: Awaited<ReturnType<typeof activeCarrier>>; aStep: string };

async function releasedThenTaken(): Promise<Scenario> {
  const orderId = await paidOrder();
  const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
  await check(accept(a.user, orderId, a.vehicleId));
  await check(release(a.user, orderId));
  await check(accept(b.user, orderId, b.vehicleId));
  return { orderId, a, b, aStep: "assigned→paid:carrier_app" };
}

async function removedByAdminThenTaken(): Promise<Scenario> {
  const orderId = await paidOrder();
  const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
  await check(accept(a.user, orderId, a.vehicleId));
  await run(service.rpc("admin_unassign_job", { p_order_id: orderId, p_admin_id: admin.id, p_reason_code: "richiesta_padroncino" }));
  await check(accept(b.user, orderId, b.vehicleId));
  return { orderId, a, b, aStep: "assigned→paid:admin_panel" };
}

describe.each([
  ["after «Rinuncia»", releasedThenTaken],
  ["after «Rimuovi padroncino»", removedByAdminThenTaken],
])("job taken over by another carrier %s", (_label, scenario) => {
  let s: Scenario;
  beforeAll(async () => {
    s = await scenario();
  });

  it("the previous carrier reads nothing of the order (old /le-mie-corse/[id] link → notice, no data)", async () => {
    expect(await whatCanRead(s.a.user, s.orderId)).toEqual(nothing);
    expect(await loadMyJob(s.a.user.client, s.a.user.id, s.orderId)).toBeNull();
    expect((await loadMyJobs(s.a.user.client, s.a.user.id)).map((j) => j.orderId)).not.toContain(s.orderId);
  });

  it("the new carrier sees the job, but nothing about the previous carrier", async () => {
    expect(await loadMyJob(s.b.user.client, s.b.user.id, s.orderId)).toMatchObject({ orderId: s.orderId });
    const b = s.b.user.client;
    const [carrier, profile, vehicle, docs] = await Promise.all([
      b.from("carriers").select("profile_id").eq("profile_id", s.a.user.id),
      b.from("profiles").select("id").eq("id", s.a.user.id),
      b.from("carrier_vehicles").select("id").eq("id", s.a.vehicleId),
      b.from("carrier_documents").select("id").eq("carrier_id", s.a.user.id),
    ]);
    expect([carrier.data, profile.data, vehicle.data, docs.data]).toEqual([[], [], [], []]);
    const order = await check(b.from("orders").select("carrier_id, carrier_vehicle_id").eq("id", s.orderId).single());
    expect(order).toEqual({ carrier_id: s.b.user.id, carrier_vehicle_id: s.b.vehicleId });
    expect((await b.from("audit_log").select("id").eq("entity_id", s.orderId)).data ?? []).toEqual([]);
  });

  it("history for the new carrier: only from its own assignment — nothing of the previous carrier (D128)", async () => {
    const rows = await historyOf(s.b.user, s.orderId);
    expect(steps(rows)).toEqual(["paid→assigned:carrier_app"]);
    expect(steps(rows)).not.toContain(s.aStep);
    expect(JSON.stringify(rows)).not.toContain(s.a.user.id);
  });

  it("history for the new carrier: changed_by, lat, lng and * are refused (column privileges)", async () => {
    for (const cols of ["changed_by", "lat", "lng", "*", "id, changed_by"]) {
      const { data, error } = await s.b.user.client.from("order_status_history").select(cols).eq("order_id", s.orderId);
      expect(error?.code, cols).toBe("42501");
      expect(data).toBeNull();
    }
  });

  it("history for the customer: every row of the order, no user ids (D128)", async () => {
    const rows = await historyOf(customer, s.orderId);
    expect(steps(rows)).toEqual([
      "∅→pending_payment:customer_app",
      "pending_payment→paid:stripe_webhook",
      "paid→assigned:carrier_app",
      s.aStep,
      "paid→assigned:carrier_app",
    ]);
    const text = JSON.stringify(rows);
    for (const id of [s.a.user.id, s.b.user.id, admin.id, customer.id]) expect(text).not.toContain(id);
    expect((await customer.client.from("order_status_history").select("changed_by").eq("order_id", s.orderId)).error?.code).toBe("42501");
    expect(await historyOf(otherCustomer, s.orderId)).toEqual([]);
  });

  it("admin: the whole history with who changed it, through admin_order_status_history", async () => {
    const { data, error } = await admin.client.rpc("admin_order_status_history", { p_order_id: s.orderId });
    expect(error).toBeNull();
    const rows = data as (History & { changed_by: string | null })[];
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.changed_by)).toEqual([
      customer.id,
      null, // Stripe webhook
      s.a.user.id,
      s.aStep.endsWith("admin_panel") ? admin.id : s.a.user.id,
      s.b.user.id,
    ]);
    // the plain table read (without changed_by) works for the admin too, all rows
    expect(await historyOf(admin, s.orderId)).toHaveLength(5);
  });
});

describe("history while the job is carried out (D128)", () => {
  it("the carrier sees its assignment and every later status; the previous carrier still nothing", async () => {
    const orderId = await paidOrder();
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    await check(accept(a.user, orderId, a.vehicleId));
    await check(release(a.user, orderId));
    await check(accept(b.user, orderId, b.vehicleId));
    for (const to of ["picked_up", "in_transit", "delivered"]) await advance(orderId, to);

    expect(steps(await historyOf(b.user, orderId))).toEqual([
      "paid→assigned:carrier_app",
      "assigned→picked_up:admin_panel",
      "picked_up→in_transit:admin_panel",
      "in_transit→delivered:admin_panel",
    ]);
    expect(await whatCanRead(a.user, orderId)).toEqual(nothing);
  });

  it("assigned by the admin (no previous carrier): the carrier sees its own assignment row", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await run(service.rpc("admin_assign_job", { p_order_id: orderId, p_carrier_id: c.user.id, p_vehicle_id: c.vehicleId, p_admin_id: admin.id }));
    expect(steps(await historyOf(c.user, orderId))).toEqual(["paid→assigned:admin_panel"]);
  });
});

describe("admin_order_status_history: admins only", () => {
  it("customer, carrier, anonymous and a blocked admin are refused", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await check(accept(c.user, orderId, c.vehicleId));
    for (const [who, client] of [
      ["customer", customer.client],
      ["carrier", c.user.client],
      ["anon", anon],
      ["blocked admin", blockedAdmin.client],
    ] as const) {
      const { data, error } = await client.rpc("admin_order_status_history", { p_order_id: orderId });
      expect(error, who).not.toBeNull();
      expect(data ?? [], who).toEqual([]);
    }
  });
});
