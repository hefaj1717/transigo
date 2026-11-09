import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteCreatedUsers, service, type TestUser } from "./helpers";
import { accept, activeCarrier, check, paidOrder, release, run, setupJobContext, teardownJobContext } from "./job-fixtures";
import { loadMyJob, loadMyJobs } from "@/lib/carriers/jobs-server";

// Reassigned jobs on the LOCAL database (D64): carrier A accepts and gives the job up ("Rinuncia", or the admin
// removes A with "Rimuovi padroncino"), carrier B accepts it.
//  - A, from then on, reads nothing of the order (an old link to /padroncino/le-mie-corse/[id] shows the
//    "non è più assegnata a te" notice: loadMyJob returns null);
//  - B reads nothing about A (company, vehicles, documents) and no admin data (audit_log with the reason code).
//  - Known gap (D128): order_status_history.changed_by shows B the user id of A (and of the customer / admin).
//    Fixing it needs a migration — the test is marked `it.fails` until then and turns red once it is fixed.

let admin: TestUser;

beforeAll(async () => {
  ({ admin } = await setupJobContext());
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

/** Everything A could still try to read about the order with its own session. */
async function whatCanRead(c: TestUser, orderId: string) {
  const [orders, legs, history, terms] = await Promise.all([
    c.client.from("orders").select("id").eq("id", orderId),
    c.client.from("order_legs").select("order_id").eq("order_id", orderId),
    c.client.from("order_status_history").select("id").eq("order_id", orderId),
    c.client.from("order_leg_carrier_terms").select("order_id").eq("order_id", orderId),
  ]);
  for (const r of [orders, legs, history, terms]) expect(r.error).toBeNull();
  return { orders: orders.data?.length, legs: legs.data?.length, history: history.data?.length, terms: terms.data?.length };
}

const nothing = { orders: 0, legs: 0, history: 0, terms: 0 };

type Scenario = { orderId: string; a: Awaited<ReturnType<typeof activeCarrier>>; b: Awaited<ReturnType<typeof activeCarrier>> };

async function releasedThenTaken(): Promise<Scenario> {
  const orderId = await paidOrder();
  const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
  await check(accept(a.user, orderId, a.vehicleId));
  await check(release(a.user, orderId));
  await check(accept(b.user, orderId, b.vehicleId));
  return { orderId, a, b };
}

async function removedByAdminThenTaken(): Promise<Scenario> {
  const orderId = await paidOrder();
  const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
  await check(accept(a.user, orderId, a.vehicleId));
  await run(service.rpc("admin_unassign_job", { p_order_id: orderId, p_admin_id: admin.id, p_reason_code: "richiesta_padroncino" }));
  await check(accept(b.user, orderId, b.vehicleId));
  return { orderId, a, b };
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
    // the order row itself points at B only
    const order = await check(b.from("orders").select("carrier_id, carrier_vehicle_id").eq("id", s.orderId).single());
    expect(order).toEqual({ carrier_id: s.b.user.id, carrier_vehicle_id: s.b.vehicleId });
  });

  it("the new carrier reads no admin data: no audit_log (reason code, previous carrier), no notes in the history", async () => {
    const b = s.b.user.client;
    const audit = await b.from("audit_log").select("id").eq("entity_id", s.orderId);
    expect(audit.data ?? []).toEqual([]);
    const notes = await check(b.from("order_status_history").select("note, lat, lng").eq("order_id", s.orderId));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((r) => r.note === null && r.lat === null && r.lng === null)).toBe(true);
  });

  // KNOWN GAP (D128) — order_status_history is readable column-for-column by every party of the order, so
  // changed_by carries the previous carrier's user id. Needs a migration (owner's approval). When fixed, this
  // test starts failing: remove `.fails`.
  it.fails("the new carrier does not see the previous carrier's id in the status history", async () => {
    const rows = await check(s.b.user.client.from("order_status_history").select("*").eq("order_id", s.orderId));
    expect(JSON.stringify(rows)).not.toContain(s.a.user.id);
  });
});
