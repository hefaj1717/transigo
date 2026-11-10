import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, localSql, service, type TestUser } from "./helpers";
import { accept, activeCarrier, addVehicle, check, history, orderRow, paidOrder, run, setupJobContext, teardownJobContext, type DbError } from "./job-fixtures";

// Admin dispatch, minimal version (D122, D123): candidates, assign (same rules as accept_job, no override),
// unassign with a reason code (audit only), one-step status changes, delivered without POD (never back to false).

let admin: TestUser;
let blockedAdmin: TestUser;
let customer: TestUser;

const candidates = (orderId: string, adminId = admin.id) => service.rpc("admin_job_candidates", { p_order_id: orderId, p_admin_id: adminId });
const assign = (orderId: string, carrierId: string, vehicleId: string, adminId = admin.id) =>
  service.rpc("admin_assign_job", { p_order_id: orderId, p_carrier_id: carrierId, p_vehicle_id: vehicleId, p_admin_id: adminId });
const unassign = (orderId: string, reason: string | null = "errore_admin", adminId = admin.id) =>
  service.rpc("admin_unassign_job", { p_order_id: orderId, p_admin_id: adminId, p_reason_code: reason });
const advance = (orderId: string, to: string, adminId = admin.id) =>
  service.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: adminId, p_to_status: to });
const lastAudit = async (orderId: string) =>
  (await check(service.from("audit_log").select("action, actor_id, actor_email, entity_type, data").eq("entity_id", orderId).order("id", { ascending: false }).limit(1)))[0];
const fullOrder = (id: string) =>
  check(service.from("orders").select("status, carrier_id, picked_up_at, in_transit_at, delivered_at, delivered_without_pod").eq("id", id).single());

beforeAll(async () => {
  ({ admin, customer } = await setupJobContext());
  blockedAdmin = await createUser({});
  await run(service.from("profiles").update({ role: "admin", is_blocked: false }).eq("id", blockedAdmin.id));
  await run(service.from("profiles").update({ is_blocked: true }).eq("id", blockedAdmin.id));
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("who may call the dispatch functions", () => {
  it("only the server (service role): anon, cliente, padroncino and admin through the API are refused", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    for (const client of [anon, customer.client, c.user.client, admin.client]) {
      expect((await client.rpc("admin_job_candidates", { p_order_id: orderId, p_admin_id: admin.id })).error).not.toBeNull();
      expect((await client.rpc("admin_assign_job", { p_order_id: orderId, p_carrier_id: c.user.id, p_vehicle_id: c.vehicleId, p_admin_id: admin.id })).error).not.toBeNull();
      expect((await client.rpc("admin_unassign_job", { p_order_id: orderId, p_admin_id: admin.id, p_reason_code: "altro" })).error).not.toBeNull();
      expect((await client.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: admin.id, p_to_status: "picked_up" })).error).not.toBeNull();
    }
    expect((await orderRow(orderId)).status).toBe("paid");
  });

  it("p_admin_id must be an active admin (blocked admin, customer, carrier → 42501)", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    for (const who of [blockedAdmin.id, customer.id, c.user.id, randomUUID()]) {
      expect((await candidates(orderId, who)).error?.code).toBe("42501");
      expect((await assign(orderId, c.user.id, c.vehicleId, who)).error?.code).toBe("42501");
      expect((await unassign(orderId, "altro", who)).error?.code).toBe("42501");
      expect((await advance(orderId, "picked_up", who)).error?.code).toBe("42501");
    }
  });
});

describe("admin_job_candidates (D120 rules)", () => {
  it("only active carriers with approved documents and ready, fitting vehicles", async () => {
    const orderId = await paidOrder({ vehicle: "van_medium" });
    const ok = await activeCarrier("van_medium", 1200);
    const small = await activeCarrier("car", 400);
    const suspended = await activeCarrier("van_medium", 1200);
    await run(service.rpc("set_carrier_suspension", { p_carrier_id: suspended.user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "x" }));
    const notApproved = await addVehicle(ok.user, "van_large", { payload_kg: 1000 });

    const rows = await check(candidates(orderId));
    const vehicleIds = rows.map((r: { vehicle_id: string }) => r.vehicle_id);
    expect(vehicleIds).toContain(ok.vehicleId);
    expect(vehicleIds).not.toContain(small.vehicleId);
    expect(vehicleIds).not.toContain(suspended.vehicleId);
    expect(vehicleIds).not.toContain(notApproved);
    expect(rows.find((r: { vehicle_id: string }) => r.vehicle_id === ok.vehicleId)).toMatchObject({ carrier_id: ok.user.id, company_name: "Trasporti Corse Srl" });
  });

  it("empty for an order that is not available", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await run(assign(orderId, c.user.id, c.vehicleId));
    expect(await check(candidates(orderId))).toEqual([]);
  });
});

describe("admin_assign_job (D122): same rules as accept_job, no override", () => {
  it("paid → assigned; history admin_panel; audit with ids", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    expect((await assign(orderId, c.user.id, c.vehicleId)).error).toBeNull();
    expect(await orderRow(orderId)).toMatchObject({ status: "assigned", carrier_id: c.user.id, carrier_vehicle_id: c.vehicleId });
    expect((await history(orderId)).at(-1)).toEqual({ from_status: "paid", to_status: "assigned", changed_by: admin.id, source: "admin_panel" });
    expect(await lastAudit(orderId)).toEqual({
      action: "order.assigned", actor_id: admin.id, actor_email: admin.email, entity_type: "order",
      data: { carrier_id: c.user.id, vehicle_id: c.vehicleId },
    });
    // the carrier now sees it as its own job
    expect((await check(c.user.client.from("orders").select("id").eq("id", orderId))).length).toBe(1);
  });

  it("refuses: suspended carrier, unfit or unapproved vehicle, someone else's vehicle, taken order", async () => {
    const orderId = await paidOrder({ vehicle: "van_medium" });
    const [ok, other, suspended] = await Promise.all([activeCarrier(), activeCarrier(), activeCarrier()]);
    await run(service.rpc("set_carrier_suspension", { p_carrier_id: suspended.user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "x" }));
    const small = await addVehicle(ok.user, "car", { payload_kg: 400 });
    await run(service.rpc("approve_carrier_vehicle", { p_vehicle_id: small, p_admin_id: admin.id }));
    const notApproved = await addVehicle(ok.user, "van_medium", { payload_kg: 1200 });

    expect((await assign(orderId, suspended.user.id, suspended.vehicleId)).error).toMatchObject({ code: "55000", details: "carrier_not_eligible:carrier_not_active" });
    expect((await assign(orderId, ok.user.id, small)).error).toMatchObject({ code: "55000", details: "vehicle_not_suitable" });
    expect((await assign(orderId, ok.user.id, notApproved)).error).toMatchObject({ code: "55000", details: "vehicle_not_ready" });
    expect((await assign(orderId, ok.user.id, other.vehicleId)).error).toMatchObject({ code: "22023", details: "vehicle" });
    await run(assign(orderId, ok.user.id, ok.vehicleId));
    expect((await assign(orderId, other.user.id, other.vehicleId)).error).toMatchObject({ code: "55000", details: "already_taken" });
  });

  it("race with a carrier's accept_job: exactly one wins", async () => {
    for (let round = 0; round < 3; round++) {
      const orderId = await paidOrder();
      const [byAdmin, byCarrier] = await Promise.all([activeCarrier(), activeCarrier()]);
      const [a, b] = await Promise.all([assign(orderId, byAdmin.user.id, byAdmin.vehicleId), accept(byCarrier.user, orderId, byCarrier.vehicleId)]);
      const errors = [a.error, b.error].filter(Boolean) as DbError[];
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: "55000", details: "already_taken" });
      expect((await history(orderId)).filter((h) => h.to_status === "assigned")).toHaveLength(1);
    }
  });
});

describe("admin_unassign_job (D39, D122)", () => {
  it("assigned → paid; reason code only in the audit; the order is a candidate again", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await run(assign(orderId, c.user.id, c.vehicleId));
    expect((await unassign(orderId, "richiesta_padroncino")).error).toBeNull();
    expect(await orderRow(orderId)).toMatchObject({ status: "paid", carrier_id: null, carrier_vehicle_id: null, assigned_at: null });
    expect((await history(orderId)).at(-1)).toEqual({ from_status: "assigned", to_status: "paid", changed_by: admin.id, source: "admin_panel" });
    expect((await lastAudit(orderId)).data).toEqual({ carrier_id: c.user.id, vehicle_id: c.vehicleId, reason_code: "richiesta_padroncino", pickup_window_passed: false });
    expect((await check(candidates(orderId))).map((r: { vehicle_id: string }) => r.vehicle_id)).toContain(c.vehicleId);
  });

  it("unknown or missing reason code → 22023; not assigned → 55000", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    expect((await unassign(orderId)).error).toMatchObject({ code: "55000", details: "not_assigned" });
    await run(assign(orderId, c.user.id, c.vehicleId));
    for (const reason of [null, "", "il cliente ha chiamato", "ERRORE_ADMIN"]) {
      expect((await unassign(orderId, reason)).error).toMatchObject({ code: "22023", details: "reason" });
    }
    await run(advance(orderId, "picked_up"));
    expect((await unassign(orderId, "altro")).error).toMatchObject({ code: "55000", details: "not_assigned" });
  });
});

describe("admin_advance_order (D122, D123)", () => {
  it("one step at a time with timestamps; delivered = without POD (flag + audit pod false)", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    expect((await advance(orderId, "picked_up")).error).toMatchObject({ code: "55000", details: "paid" });
    await run(assign(orderId, c.user.id, c.vehicleId));
    expect((await advance(orderId, "in_transit")).error).toMatchObject({ code: "55000", details: "assigned" }); // skip
    expect((await advance(orderId, "delivered")).error).toMatchObject({ code: "55000", details: "assigned" });

    expect((await advance(orderId, "picked_up")).data).toBe("picked_up");
    expect((await advance(orderId, "picked_up")).error).toMatchObject({ code: "55000", details: "picked_up" }); // twice
    expect((await advance(orderId, "in_transit")).data).toBe("in_transit");
    expect((await fullOrder(orderId)).delivered_without_pod).toBe(false);
    expect((await advance(orderId, "delivered")).data).toBe("delivered");

    const o = await fullOrder(orderId);
    expect(o).toMatchObject({ status: "delivered", delivered_without_pod: true });
    expect(o.picked_up_at && o.in_transit_at && o.delivered_at).toBeTruthy();
    expect((await history(orderId)).slice(-3).map((h) => [h.from_status, h.to_status, h.source])).toEqual([
      ["assigned", "picked_up", "admin_panel"], ["picked_up", "in_transit", "admin_panel"], ["in_transit", "delivered", "admin_panel"],
    ]);
    expect((await lastAudit(orderId)).data).toEqual({ from: "in_transit", to: "delivered", pod: false });
    expect((await advance(orderId, "delivered")).error).toMatchObject({ code: "55000", details: "delivered" });
  });

  it("unknown or backward targets → 22023", async () => {
    const orderId = await paidOrder();
    for (const to of ["assigned", "paid", "completed", "cancelled"]) {
      expect((await advance(orderId, to)).error).toMatchObject({ code: "22023", details: "status" });
    }
  });
});

describe("delivered_without_pod never goes back to false (D123)", () => {
  it("for the service role and the database owner (SQL), with no session flag", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await run(assign(orderId, c.user.id, c.vehicleId));
    for (const to of ["picked_up", "in_transit", "delivered"]) await run(advance(orderId, to));

    expect((await service.from("orders").update({ delivered_without_pod: false }).eq("id", orderId)).error).toMatchObject({ code: "23514" });
    const sql = localSql(`update public.orders set delivered_without_pod = false where id = '${orderId}';`);
    expect(sql.ok).toBe(false);
    expect(sql.output).toContain("23514");
    expect((await fullOrder(orderId)).delivered_without_pod).toBe(true);
  });

  it("the carrier and the customer cannot change it at all", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await run(assign(orderId, c.user.id, c.vehicleId));
    await c.user.client.from("orders").update({ delivered_without_pod: true }).eq("id", orderId);
    await customer.client.from("orders").update({ delivered_without_pod: true }).eq("id", orderId);
    expect((await fullOrder(orderId)).delivered_without_pod).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server code behind the /admin/ordini actions (src/lib/orders/dispatch-server.ts)
// ---------------------------------------------------------------------------

describe("dispatch-server: messages and the admin from deps", () => {
  let srv: typeof import("@/lib/orders/dispatch-server");
  let msg: typeof import("@/lib/orders/dispatch").DISPATCH_MSG;
  const deps = (adminId = admin.id, email = admin.email) => ({ admin: { userId: adminId, email }, serviceDb: service, appUrl: "https://transigo.example" });

  beforeAll(async () => {
    srv = await import("@/lib/orders/dispatch-server");
    msg = (await import("@/lib/orders/dispatch")).DISPATCH_MSG;
  });

  it("candidates → assign → next statuses → delivered without POD message", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    const list = await srv.loadCandidates(deps(), orderId);
    expect(list.map((x) => x.vehicle_id)).toContain(c.vehicleId);
    expect(await srv.assignJob(deps(), { orderId, candidate: `${c.user.id}:${c.vehicleId}` })).toEqual({ ok: true, message: msg.assigned });
    expect(await srv.advanceOrder(deps(), { orderId, to: "picked_up" })).toEqual({ ok: true, message: "Stato aggiornato: Ritirato." });
    expect(await srv.advanceOrder(deps(), { orderId, to: "picked_up" })).toEqual({ ok: false, error: msg.notNextStatus });
    await srv.advanceOrder(deps(), { orderId, to: "in_transit" });
    const done = await srv.advanceOrder(deps(), { orderId, to: "delivered" });
    expect(done).toEqual({ ok: true, message: `Stato aggiornato: Consegnato. ${msg.deliveredWithoutPod}` });
  });

  it("customer e-mails: order_assigned after each Assegna (D129), order_delivered once", async () => {
    const orderId = await paidOrder();
    const [c, d] = await Promise.all([activeCarrier(), activeCarrier()]);
    await run(service.from("profiles").update({ first_name: "Mario" }).eq("id", c.user.id));
    await run(service.from("profiles").update({ first_name: "Paolo" }).eq("id", d.user.id));
    const mails = async () =>
      check(service.from("email_outbox").select("template_code, to_address, subject, text_body").eq("order_id", orderId).in("template_code", ["order_assigned", "order_delivered"]).order("created_at"));

    await srv.assignJob(deps(), { orderId, candidate: `${c.user.id}:${c.vehicleId}` });
    let m = await mails();
    expect(m.map((x) => x.template_code)).toEqual(["order_assigned"]);
    expect(m[0].to_address).toBe(customer.email);
    expect(m[0].text_body).toContain("Mario (Trasporti Corse Srl)");
    expect(m[0].text_body).toContain(`https://transigo.example/cliente/ordini/${orderId}`);
    expect(m[0].text_body).not.toMatch(/€|carrier_amount/); // no amounts at all

    // "Rimuovi padroncino" → Assegna another carrier: a second order_assigned with the NEW carrier (D129)
    await srv.unassignJob(deps(), { orderId, reason: "altro" });
    await srv.assignJob(deps(), { orderId, candidate: `${d.user.id}:${d.vehicleId}` });
    m = await mails();
    expect(m.map((x) => x.template_code)).toEqual(["order_assigned", "order_assigned"]);
    expect(m[1].text_body).toContain("Paolo (Trasporti Corse Srl)");
    expect(m[1].text_body).not.toContain("Mario");

    // Consegnato: order_delivered once, even when advanced to delivered again is refused / repeated
    for (const to of ["picked_up", "in_transit", "delivered"]) await srv.advanceOrder(deps(), { orderId, to });
    await srv.advanceOrder(deps(), { orderId, to: "delivered" });
    m = await mails();
    expect(m.map((x) => x.template_code)).toEqual(["order_assigned", "order_assigned", "order_delivered"]);
  });

  it("clear messages for refused assignments and unassign", async () => {
    const orderId = await paidOrder({ vehicle: "van_medium" });
    const [ok, other] = await Promise.all([activeCarrier(), activeCarrier()]);
    const small = await addVehicle(ok.user, "car", { payload_kg: 400 });
    await run(service.rpc("approve_carrier_vehicle", { p_vehicle_id: small, p_admin_id: admin.id }));
    expect(await srv.assignJob(deps(), { orderId, candidate: "" })).toEqual({ ok: false, error: msg.chooseCandidate });
    expect(await srv.assignJob(deps(), { orderId, candidate: `${ok.user.id}:${small}` })).toEqual({ ok: false, error: msg.vehicleNotSuitable });
    await srv.assignJob(deps(), { orderId, candidate: `${ok.user.id}:${ok.vehicleId}` });
    expect(await srv.assignJob(deps(), { orderId, candidate: `${other.user.id}:${other.vehicleId}` })).toEqual({ ok: false, error: msg.alreadyTaken });
    expect(await srv.unassignJob(deps(), { orderId, reason: "nope" })).toEqual({ ok: false, error: msg.chooseReason });
    expect(await srv.unassignJob(deps(), { orderId, reason: "problema_veicolo" })).toEqual({ ok: true, message: msg.unassigned });
  });

  it("a blocked admin's id is refused by the database even if it reached the server code", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    expect(await srv.assignJob(deps(blockedAdmin.id, blockedAdmin.email), { orderId, candidate: `${c.user.id}:${c.vehicleId}` })).toEqual({ ok: false, error: msg.forbidden });
    expect((await orderRow(orderId)).status).toBe("paid");
  });
});
