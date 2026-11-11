import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";
import { activeCarrier, check, paidOrder, run, setupJobContext, teardownJobContext, type DbError } from "./job-fixtures";

// Customer block by the admin (D143; migration 20261111170000_admin_customer_block.sql). On the real database:
// service role only, active admin only, customers only; a reason code to block; audit in the same transaction
// (codes only); the blocked customer reads nothing with its session; the orders under way are counted, not touched.

let customer: TestUser;
let admin: TestUser;
let blockedAdmin: TestUser;
let carrier: { user: TestUser; vehicleId: string };

const setBlocked = (customerId: string, block: boolean, reason: string | null = "abuse", adminId = admin.id) =>
  service.rpc("admin_set_customer_blocked", { p_customer_id: customerId, p_admin_id: adminId, p_block: block, p_reason_code: reason })
    .single<{ changed: boolean; active_orders: number }>();
const isBlocked = async (id: string) => (await check(service.from("profiles").select("is_blocked").eq("id", id).single())).is_blocked;

beforeAll(async () => {
  const ctx = await setupJobContext();
  customer = ctx.customer;
  admin = ctx.admin;
  carrier = await activeCarrier("van_medium", 1200);
  blockedAdmin = await createUser({});
  await run(service.from("profiles").update({ role: "admin", is_blocked: true }).eq("id", blockedAdmin.id));
});

afterAll(async () => {
  await run(service.from("profiles").update({ is_blocked: false }).eq("id", customer.id));
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("who may call", () => {
  it("anon, customer, carrier and admin sessions cannot execute it", async () => {
    for (const client of [anon, customer.client, carrier.user.client, admin.client]) {
      const { error } = await client.rpc("admin_set_customer_blocked", { p_customer_id: customer.id, p_admin_id: admin.id, p_block: true, p_reason_code: "abuse" });
      expect((error as DbError)?.code).toBe("42501");
    }
    expect(await isBlocked(customer.id)).toBe(false);
  });

  it("a blocked admin or a non-admin id is refused", async () => {
    for (const adminId of [blockedAdmin.id, customer.id]) {
      expect((await setBlocked(customer.id, true, "abuse", adminId)).error).toMatchObject({ code: "42501" });
    }
    expect(await isBlocked(customer.id)).toBe(false);
  });

  it("only customers: a carrier, an admin or an unknown id is 'not found'", async () => {
    for (const id of [carrier.user.id, admin.id, randomUUID()]) {
      expect((await setBlocked(id, true)).error).toMatchObject({ code: "22023", details: "customer" });
    }
    expect(await isBlocked(carrier.user.id)).toBe(false);
  });

  it("blocking needs a reason code from the list", async () => {
    for (const reason of [null, "", "because"]) {
      expect((await setBlocked(customer.id, true, reason)).error).toMatchObject({ code: "22023", details: "reason" });
    }
    expect(await isBlocked(customer.id)).toBe(false);
  });
});

describe("block and unblock", () => {
  it("blocks with audit and the count of orders under way; the orders stay as they are", async () => {
    const orderId = await paidOrder();
    const before = (await check(service.rpc("admin_set_customer_blocked", { p_customer_id: customer.id, p_admin_id: admin.id, p_block: false, p_reason_code: null }).single<{ changed: boolean; active_orders: number }>()));
    expect(before.changed).toBe(false);

    const r = await check(setBlocked(customer.id, true, "payment_issue"));
    expect(r.changed).toBe(true);
    expect(r.active_orders).toBeGreaterThanOrEqual(1);
    expect(await isBlocked(customer.id)).toBe(true);
    expect((await check(service.from("orders").select("status").eq("id", orderId).single())).status).toBe("paid");

    const audit = await check(service.from("audit_log").select("action, actor_id, data").eq("entity_id", customer.id).eq("action", "customer.blocked"));
    expect(audit).toEqual([{ action: "customer.blocked", actor_id: admin.id, data: { reason: "payment_issue", active_orders: r.active_orders } }]);

    // The blocked customer's session reads nothing (auth_role() = null).
    expect(await check(customer.client.from("orders").select("id"))).toEqual([]);
    expect(await check(customer.client.from("customers").select("profile_id"))).toEqual([]);

    // Second click: nothing new.
    expect((await check(setBlocked(customer.id, true))).changed).toBe(false);
    expect(await check(service.from("audit_log").select("id").eq("entity_id", customer.id).eq("action", "customer.blocked"))).toHaveLength(1);
  });

  it("unblocks without a reason; access is back", async () => {
    if (!(await isBlocked(customer.id))) await check(setBlocked(customer.id, true));
    const r = await check(setBlocked(customer.id, false, null));
    expect(r.changed).toBe(true);
    expect(await isBlocked(customer.id)).toBe(false);
    expect((await check(customer.client.from("orders").select("id"))).length).toBeGreaterThanOrEqual(1);
    const audit = await check(service.from("audit_log").select("data").eq("entity_id", customer.id).eq("action", "customer.unblocked"));
    expect(audit).toHaveLength(1);
    expect(Object.keys(audit[0].data as object)).toEqual(["active_orders"]);
  });

  it("two concurrent blocks: one change, one audit row", async () => {
    const other = await createUser({});
    await run(service.from("customers").insert({ profile_id: other.id, customer_type: "private" }));
    const [a, b] = await Promise.all([setBlocked(other.id, true), setBlocked(other.id, true)]);
    expect([a.data?.changed, b.data?.changed].sort()).toEqual([false, true]);
    expect(await check(service.from("audit_log").select("id").eq("entity_id", other.id))).toHaveLength(1);
  });
});
