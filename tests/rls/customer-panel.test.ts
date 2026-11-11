import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";
import { activeCarrier, check, paidOrder, run, setupJobContext, teardownJobContext } from "./job-fixtures";

// Customer panel (spec 7): customer_order_carrier() — the customer sees only first name, company name,
// vehicle type and plate of the carrier of THEIR order, and only while a carrier is assigned.

let admin: TestUser;
let customer: TestUser;
let otherCustomer: TestUser;

const assign = (orderId: string, carrierId: string, vehicleId: string) =>
  service.rpc("admin_assign_job", { p_order_id: orderId, p_carrier_id: carrierId, p_vehicle_id: vehicleId, p_admin_id: admin.id });
const advance = (orderId: string, to: string) => service.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: admin.id, p_to_status: to, p_note: to === "delivered" ? "Test" : null });
const carrierOf = async (c: TestUser["client"], orderId: string) => {
  const { data, error } = await c.rpc("customer_order_carrier", { p_order_id: orderId });
  return { rows: (data ?? []) as Record<string, unknown>[], error };
};

async function assignedOrder() {
  const orderId = await paidOrder({ vehicle: "van_medium" });
  const c = await activeCarrier("van_medium", 1200);
  await run(service.from("profiles").update({ first_name: "Mario", phone: "+39 333 0000000" }).eq("id", c.user.id));
  await run(assign(orderId, c.user.id, c.vehicleId));
  return { orderId, carrier: c };
}

beforeAll(async () => {
  ({ admin, customer } = await setupJobContext());
  otherCustomer = await createUser({});
  await run(service.from("customers").insert({ profile_id: otherCustomer.id, customer_type: "private" }));
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("customer_order_carrier", () => {
  it("the owner sees exactly first name, company, vehicle type and plate", async () => {
    const { orderId, carrier } = await assignedOrder();
    const { rows, error } = await carrierOf(customer.client, orderId);
    expect(error).toBeNull();
    const plate = (await check(service.from("carrier_vehicles").select("plate").eq("id", carrier.vehicleId).single())).plate;
    const typeName = (await check(service.from("vehicle_types").select("name_it").eq("code", "van_medium").single())).name_it;
    expect(rows).toEqual([{ first_name: "Mario", company_name: "Trasporti Corse Srl", vehicle_type: typeName, plate }]);
  });

  it("nothing for another customer, the carrier, an admin through the API or anonymous", async () => {
    const { orderId, carrier } = await assignedOrder();
    for (const c of [otherCustomer.client, carrier.user.client, admin.client]) {
      const { rows, error } = await carrierOf(c, orderId);
      expect(error).toBeNull();
      expect(rows).toEqual([]);
    }
    expect((await anon.rpc("customer_order_carrier", { p_order_id: orderId })).error).not.toBeNull();
  });

  it("nothing before assignment and after the admin removes the carrier (D122)", async () => {
    const orderId = await paidOrder({ vehicle: "van_medium" });
    expect((await carrierOf(customer.client, orderId)).rows).toEqual([]);
    const c = await activeCarrier("van_medium", 1200);
    await run(assign(orderId, c.user.id, c.vehicleId));
    expect((await carrierOf(customer.client, orderId)).rows).toHaveLength(1);
    await run(service.rpc("admin_unassign_job", { p_order_id: orderId, p_admin_id: admin.id, p_reason_code: "altro" }));
    expect((await carrierOf(customer.client, orderId)).rows).toEqual([]);
  });

  it("still visible while picked up, in transit and after delivery", async () => {
    const { orderId } = await assignedOrder();
    for (const to of ["picked_up", "in_transit", "delivered"]) {
      await run(advance(orderId, to));
      expect((await carrierOf(customer.client, orderId)).rows).toHaveLength(1);
    }
  });

  it("nothing for a blocked customer", async () => {
    const { orderId } = await assignedOrder();
    await run(service.from("profiles").update({ is_blocked: true }).eq("id", customer.id));
    try {
      expect((await carrierOf(customer.client, orderId)).rows).toEqual([]);
    } finally {
      await run(service.from("profiles").update({ is_blocked: false }).eq("id", customer.id));
    }
  });

  it("the customer still cannot read carriers or carrier_vehicles directly", async () => {
    const { carrier } = await assignedOrder();
    expect((await customer.client.from("carriers").select("profile_id").eq("profile_id", carrier.user.id)).data).toEqual([]);
    expect((await customer.client.from("carrier_vehicles").select("id").eq("id", carrier.vehicleId)).data).toEqual([]);
  });
});
