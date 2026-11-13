import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";
import { check, list, paidOrder, run, setupJobContext, teardownJobContext, type DbError } from "./job-fixtures";
import { complete, doLeg, runningJob, signature, sql } from "./execution-fixtures";

// Loading and unloading help (migration 20261113100000_loading_help.sql, D182, docs/plany/carico-scarico.md):
// columns and checks of order_legs, time per side computed only by the database, stored with the POD.
// LOCAL database only (D64).

const HELP = {
  porter_package_code: null, porters_count: 0, porters_included_hours: null, porter_overtime_grace_minutes: 15,
  loading_porters: 1, loading_hours: 1, unloading_porters: 2, unloading_hours: 2,
};

let customer: TestUser;
let otherCustomer: TestUser;

beforeAll(async () => {
  ({ customer } = await setupJobContext());
  otherCustomer = await createUser({});
  await run(service.from("customers").insert({ profile_id: otherCustomer.id, customer_type: "private" }));
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

const legOf = (orderId: string) =>
  check(service.from("order_legs")
    .select("porters_count, loading_porters, loading_hours, unloading_porters, unloading_hours, loading_worked_minutes, unloading_worked_minutes")
    .eq("order_id", orderId).single());

async function createError(leg0: Record<string, unknown>): Promise<DbError> {
  try {
    await paidOrder({ leg0 });
    return null;
  } catch (e) {
    return e as DbError;
  }
}

describe("order_legs: loading / unloading help", () => {
  it("create_order stores the help per side; the customer reads it, the carrier list shows it without personal data", async () => {
    const orderId = await paidOrder({ leg0: HELP });
    expect(await legOf(orderId)).toEqual({
      porters_count: 0, loading_porters: 1, loading_hours: 1, unloading_porters: 2, unloading_hours: 2,
      loading_worked_minutes: null, unloading_worked_minutes: null,
    });
    const mine = await check(customer.client.from("order_legs").select("loading_porters, unloading_hours").eq("order_id", orderId));
    expect(mine).toEqual([{ loading_porters: 1, unloading_hours: 2 }]);
    expect(await check(otherCustomer.client.from("order_legs").select("loading_porters").eq("order_id", orderId))).toEqual([]);
  });

  it("a leg has the package porters OR the help per side, hours only with persons, grace with any porters", async () => {
    const bad = [
      { ...HELP, porter_package_code: "parcels", porters_count: 2, porters_included_hours: 1 }, // both
      { ...HELP, loading_hours: null }, // persons without hours
      { ...HELP, unloading_porters: 0 }, // hours without persons
      { ...HELP, porter_overtime_grace_minutes: null }, // help without grace
      { ...HELP, loading_hours: 5 }, // 1–4 h (owner 2026-11-13)
      { ...HELP, unloading_porters: 5 }, // 1–4 persons
    ];
    for (const leg0 of bad) expect(await createError(leg0), JSON.stringify(leg0)).not.toBeNull();
    // only unloading help is fine
    const ok = await paidOrder({ leg0: { ...HELP, loading_porters: 0, loading_hours: null } });
    expect((await legOf(ok)).unloading_porters).toBe(2);
  });

  it("the snapshot is immutable, also for the service role; the measured minutes are not writable by sessions", async () => {
    const orderId = await paidOrder({ leg0: HELP });
    const r = await service.from("order_legs").update({ loading_porters: 3 }).eq("order_id", orderId);
    expect(r.error).not.toBeNull();
    const s = await customer.client.from("order_legs").update({ loading_worked_minutes: 1 }).eq("order_id", orderId).select("order_id");
    expect(s.data ?? []).toEqual([]);
    expect((await legOf(orderId)).loading_worked_minutes).toBeNull();
  });
});

describe("working time per side (computed only by the database)", () => {
  it("loading = loaded − arrived_pickup, unloading = unloaded − arrived_delivery; stored with the POD", async () => {
    const { orderId, c } = await runningJob({ leg0: HELP });
    // the carrier list of the job before it was accepted showed the help (checked on a fresh order)
    const fresh = await paidOrder({ leg0: HELP, hoursAhead: 96 });
    const { rows: [job], error } = await list(c.user, fresh);
    expect(error).toBeNull();
    expect(job.legs[0]).toMatchObject({ loading_porters: 1, loading_hours: 1, unloading_porters: 2, unloading_hours: 2 });

    await doLeg(c.user, orderId, 0);
    sql(`set session_replication_role = replica;
      update public.order_leg_steps s set created_at = (select o.assigned_at from public.orders o where o.id = s.order_id) + v.off
        from (values ('arrived_pickup'::public.order_leg_step, interval '0'), ('loaded', interval '50 minutes 59 seconds'),
                     ('departed', interval '55 minutes'), ('arrived_delivery', interval '2 hours'), ('unloaded', interval '4 hours 10 minutes'))
             as v(step, off)
       where s.order_id = '${orderId}' and s.step = v.step and s.reverted_at is null;`);
    const calc = await check(customer.client.rpc("order_loading_help_minutes", { p_order_id: orderId }));
    expect(calc).toEqual([
      { leg_index: 0, side: "loading", worked_minutes: 50, complete: true },
      { leg_index: 0, side: "unloading", worked_minutes: 130, complete: true },
    ]);
    expect(await check(c.user.client.rpc("order_loading_help_minutes", { p_order_id: orderId }))).toEqual(calc);
    expect(await check(otherCustomer.client.rpc("order_loading_help_minutes", { p_order_id: orderId }))).toEqual([]);
    expect((await anon.rpc("order_loading_help_minutes", { p_order_id: orderId })).error).not.toBeNull();
    // the package porters function ignores legs with help per side
    expect(await check(customer.client.rpc("order_porters_worked_minutes", { p_order_id: orderId }))).toEqual([]);

    expect((await complete(c.user, orderId, "Lucia Bianchi", await signature(c.user, orderId))).error).toBeNull();
    expect(await legOf(orderId)).toMatchObject({ loading_worked_minutes: 50, unloading_worked_minutes: 130 });
  });

  it("only one side with help: the other side is not measured", async () => {
    const { orderId, c } = await runningJob({ leg0: { ...HELP, loading_porters: 0, loading_hours: null } });
    await doLeg(c.user, orderId, 0);
    const calc = await check(service.rpc("order_loading_help_minutes", { p_order_id: orderId }));
    expect(calc.map((r: { side: string }) => r.side)).toEqual(["unloading"]);
    expect((await complete(c.user, orderId, "Lucia Bianchi", await signature(c.user, orderId))).error).toBeNull();
    expect(await legOf(orderId)).toMatchObject({ loading_worked_minutes: null, unloading_worked_minutes: 0 });
  });
});
