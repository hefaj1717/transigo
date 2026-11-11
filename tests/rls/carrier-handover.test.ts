import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, deleteCreatedUsers, localSql, service, type TestUser } from "./helpers";
import { accept, activeCarrier, check, list, listedIds, paidOrder, release, run, setupJobContext, teardownJobContext } from "./job-fixtures";
import { complete, doLeg, historyRows, photo, pickupToday, runningJob, signature, step } from "./execution-fixtures";

// "Da gestire" (migration 20261111120000_carrier_handover.sql, owner 2026-11-11, D130): the admin removed a
// carrier with the load on board. LOCAL database only (D64).

let admin: TestUser;
let customer: TestUser;

const unassign = (orderId: string, reason = "padroncino_non_disponibile") =>
  service.rpc("admin_unassign_job", { p_order_id: orderId, p_admin_id: admin.id, p_reason_code: reason });
const handover = (orderId: string, carrierId: string, vehicleId: string, address: string | null = "Deposito Rossi, Via Emilia 10, Lodi", reason: string | null = "Furgone in panne, merce nel deposito del padroncino") =>
  service.rpc("admin_assign_handover", { p_order_id: orderId, p_carrier_id: carrierId, p_vehicle_id: vehicleId, p_admin_id: admin.id, p_address: address, p_reason: reason });
const flags = (id: string) =>
  check(service.from("orders").select("status, carrier_id, carrier_vehicle_id, assigned_at, picked_up_at, handover_required_at, handover_leg_index, delivered_without_pod").eq("id", id).single());

/** Running job with the load on board of leg 0 (arrived, photo, loaded). */
async function loadedJob() {
  const job = await runningJob();
  await run(step(job.c.user, job.orderId, 0, "arrived_pickup"));
  await photo(job.c.user, job.orderId, 0, "pickup");
  await run(step(job.c.user, job.orderId, 0, "loaded"));
  return job;
}

beforeAll(async () => {
  ({ admin, customer } = await setupJobContext());
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("Rimuovi padroncino with the load on board → da gestire", () => {
  it("status kept, carrier removed, flag set for the admin only; no history row for the customer", async () => {
    const { orderId, c } = await loadedJob();
    const before = await historyRows(orderId);
    await run(unassign(orderId));

    const o = await flags(orderId);
    expect(o).toMatchObject({ status: "picked_up", carrier_id: null, carrier_vehicle_id: null, assigned_at: null, handover_leg_index: 0, delivered_without_pod: false });
    expect(o.handover_required_at).toBeTruthy();
    expect(o.picked_up_at).toBeTruthy();
    expect(await historyRows(orderId)).toHaveLength(before.length);

    // the admin sees the flag; the customer still sees "Ritirato" and no carrier
    const adminView = await check(admin.client.from("orders").select("handover_required_at, status").eq("id", orderId).single());
    expect(adminView.handover_required_at).toBeTruthy();
    expect(await check(customer.client.from("orders").select("status").eq("id", orderId).single())).toEqual({ status: "picked_up" });
    expect(await check(customer.client.rpc("customer_order_carrier", { p_order_id: orderId }))).toEqual([]);
    // the removed carrier reads nothing any more
    expect(await check(c.user.client.from("orders").select("id").eq("id", orderId))).toHaveLength(0);
  });

  it("no carrier sees it on the list or can accept it; admin_assign_job refuses it", async () => {
    const { orderId, c } = await loadedJob();
    await run(unassign(orderId));
    const other = await activeCarrier();
    for (const u of [other, c]) {
      expect(await listedIds(u.user)).not.toContain(orderId);
      const one = await list(u.user, orderId);
      expect(one.rows).toHaveLength(0);
      expect((await accept(u.user, orderId, u.vehicleId)).error).toMatchObject({ code: "55000", details: "not_available" });
    }
    const viaAssign = await service.rpc("admin_assign_job", { p_order_id: orderId, p_carrier_id: other.user.id, p_vehicle_id: other.vehicleId, p_admin_id: admin.id });
    expect(viaAssign.error).toMatchObject({ code: "55000", details: "not_available" });
    expect((await flags(orderId)).carrier_id).toBeNull();
  });

  it("before loading nothing changes: back to paid and on the list", async () => {
    const { orderId, c } = await runningJob({ hoursAhead: 72 }, false);
    await run(unassign(orderId));
    expect(await flags(orderId)).toMatchObject({ status: "paid", handover_required_at: null, carrier_id: null });
    expect(await listedIds(c.user)).toContain(orderId);
  });

  it("an order the admin moved to picked_up without any step counts as on board (leg 0)", async () => {
    const { orderId } = await runningJob();
    await run(service.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: admin.id, p_to_status: "picked_up" }));
    await run(unassign(orderId));
    expect(await flags(orderId)).toMatchObject({ status: "picked_up", handover_leg_index: 0 });
  });
});

describe("admin_assign_handover — direct assignment with the current address", () => {
  it("assigns, keeps the status, the new carrier reads the address, the customer does not; the reason is internal", async () => {
    const { orderId } = await loadedJob();
    await run(unassign(orderId));
    const next = await activeCarrier();

    const cands = (await check(service.rpc("admin_job_candidates", { p_order_id: orderId, p_admin_id: admin.id }))) as { vehicle_id: string }[];
    expect(cands.map((x) => x.vehicle_id)).toContain(next.vehicleId); // pickup window passed: still candidates

    const at = await handover(orderId, next.user.id, next.vehicleId);
    expect(at.error).toBeNull();
    const o = await flags(orderId);
    expect(o).toMatchObject({ status: "picked_up", carrier_id: next.user.id, carrier_vehicle_id: next.vehicleId, handover_required_at: null, handover_leg_index: null });
    expect(o.assigned_at).toBe(at.data);

    const visible = "id, order_id, leg_index, address, carrier_id, created_at";
    expect(await check(next.user.client.from("order_handovers").select(visible).eq("order_id", orderId))).toEqual([
      expect.objectContaining({ leg_index: 0, address: "Deposito Rossi, Via Emilia 10, Lodi", carrier_id: next.user.id }),
    ]);
    expect(await check(customer.client.from("order_handovers").select(visible).eq("order_id", orderId))).toHaveLength(0);
    expect((await next.user.client.from("order_handovers").select("created_by").eq("order_id", orderId)).error).toMatchObject({ code: "42501" });
    expect(await check(admin.client.from("order_handovers").select(visible).eq("order_id", orderId))).toHaveLength(1);
    expect(await check(next.user.client.from("order_admin_notes").select("id").eq("order_id", orderId))).toHaveLength(0);
    expect(await check(customer.client.from("order_admin_notes").select("id").eq("order_id", orderId))).toHaveLength(0);
    expect(await check(service.from("order_admin_notes").select("kind, leg_index, body").eq("order_id", orderId))).toEqual([
      { kind: "handover", leg_index: 0, body: "Furgone in panne, merce nel deposito del padroncino" },
    ]);
    const audit = await check(service.from("audit_log").select("data").eq("entity_id", orderId).eq("action", "order.handover_assigned"));
    expect(audit[0].data).toEqual({ carrier_id: next.user.id, vehicle_id: next.vehicleId, leg_index: 0 });
    expect(JSON.stringify(audit)).not.toContain("Deposito");

    // the customer sees the new carrier (assigned_at is new → order_assigned mail key, D129)
    expect(await check(customer.client.rpc("customer_order_carrier", { p_order_id: orderId }))).toHaveLength(1);

    // the new carrier starts the leg from zero (its own photos) and finishes the job; the status never goes back
    expect((await step(next.user, orderId, 0, "arrived_pickup")).data).toMatchObject({ newly_recorded: true, order_status: "picked_up" });
    await photo(next.user, orderId, 0, "pickup");
    await run(step(next.user, orderId, 0, "loaded"));
    expect((await step(next.user, orderId, 0, "departed")).data?.order_status).toBe("in_transit");
    await run(step(next.user, orderId, 0, "arrived_delivery"));
    await photo(next.user, orderId, 0, "delivery");
    await run(step(next.user, orderId, 0, "unloaded"));
    expect((await complete(next.user, orderId, "Lucia", await signature(next.user, orderId))).error).toBeNull();
    expect(await flags(orderId)).toMatchObject({ status: "delivered", delivered_without_pod: false });
    // the new carrier may not "Rinuncia" either once loaded — checked before delivery in carrier-execution
  });

  it("checks: flag required, address and reason required, same carrier/vehicle rules (D120), service role only", async () => {
    const { orderId } = await loadedJob();
    const next = await activeCarrier();
    expect((await handover(orderId, next.user.id, next.vehicleId)).error).toMatchObject({ code: "55000", details: "not_handover" }); // still assigned
    await run(unassign(orderId));
    for (const address of [null, "", "   ", "x".repeat(501)]) {
      expect((await handover(orderId, next.user.id, next.vehicleId, address)).error).toMatchObject({ code: "22023", details: "address" });
    }
    for (const reason of [null, "  ", "x".repeat(1001)]) {
      expect((await handover(orderId, next.user.id, next.vehicleId, "Via X 1", reason)).error).toMatchObject({ code: "22023", details: "reason" });
    }
    const other = await activeCarrier();
    expect((await handover(orderId, next.user.id, other.vehicleId)).error).toMatchObject({ code: "22023", details: "vehicle" });
    const suspended = await activeCarrier();
    await run(service.rpc("set_carrier_suspension", { p_carrier_id: suspended.user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "Controllo" }));
    expect((await handover(orderId, suspended.user.id, suspended.vehicleId)).error).toMatchObject({ code: "55000", details: expect.stringContaining("carrier_not_eligible") });
    for (const client of [next.user.client, customer.client, admin.client, anon]) {
      const r = await client.rpc("admin_assign_handover", { p_order_id: orderId, p_carrier_id: next.user.id, p_vehicle_id: next.vehicleId, p_admin_id: admin.id, p_address: "Via X 1", p_reason: "x" });
      expect(r.error).not.toBeNull();
    }
    expect((await handover(orderId, next.user.id, next.vehicleId, "Via X 1", "ok")).error).toBeNull();
    expect((await handover(orderId, other.user.id, other.vehicleId)).error).toMatchObject({ code: "55000", details: "not_handover" }); // only once
    // append-only
    expect(localSql(`update public.order_handovers set address = 'y' where order_id = '${orderId}';`).output).toContain("42501");
  });

  it("Consegnato without POD on a da gestire order: reason required, no carrier, never automatic payout", async () => {
    const { orderId } = await loadedJob();
    await run(unassign(orderId));
    const adv = (to: string, note: string | null) => service.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: admin.id, p_to_status: to, p_note: note });
    await run(adv("in_transit", null));
    expect((await adv("delivered", null)).error).toMatchObject({ code: "22023", details: "note" });
    await run(adv("delivered", "Il padroncino rimosso ha consegnato comunque"));
    expect(await flags(orderId)).toMatchObject({ status: "delivered", carrier_id: null, delivered_without_pod: true });
    expect(await check(service.from("order_admin_notes").select("kind").eq("order_id", orderId))).toEqual([{ kind: "delivered_without_pod" }]);
  });

  it("without the flag a running order still needs a carrier (database check)", async () => {
    const { orderId } = await runningJob();
    const res = localSql(`update public.orders set carrier_id = null, carrier_vehicle_id = null where id = '${orderId}';`);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("orders_carrier_required_check");
  });
});

describe("two legs: a finished leg stays when the carrier changes", () => {
  it("leg 1 done at the warehouse, leg 2 loaded → handover of leg 2; the new carrier continues on leg 2", async () => {
    const orderId = await paidOrder({ hoursAhead: 72, storage: true });
    const a = await activeCarrier();
    await check(accept(a.user, orderId, a.vehicleId));
    pickupToday(orderId);
    await doLeg(a.user, orderId, 0);
    await run(step(a.user, orderId, 1, "arrived_pickup"));
    await photo(a.user, orderId, 1, "pickup");
    await run(step(a.user, orderId, 1, "loaded"));
    expect((await release(a.user, orderId)).error).toMatchObject({ details: "loaded" });

    await run(unassign(orderId));
    expect(await flags(orderId)).toMatchObject({ status: "in_transit", handover_leg_index: 1 });
    const live = await check(service.from("order_leg_steps").select("leg_index, step").eq("order_id", orderId).is("reverted_at", null).order("id"));
    expect(live.map((s) => `${s.leg_index}:${s.step}`)).toEqual(["0:arrived_pickup", "0:loaded", "0:departed", "0:arrived_delivery", "0:unloaded"]);

    const b = await activeCarrier();
    await run(handover(orderId, b.user.id, b.vehicleId));
    // B reads the finished leg 1 (times only), not A's reverted steps of leg 2
    const seen = await check(b.user.client.from("order_leg_steps").select("leg_index, step, reverted_at").eq("order_id", orderId).order("id"));
    expect(seen.map((s) => `${s.leg_index}:${s.step}`)).toEqual(["0:arrived_pickup", "0:loaded", "0:departed", "0:arrived_delivery", "0:unloaded"]);
    expect((await step(b.user, orderId, 0, "unloaded")).data?.newly_recorded).toBe(false);
    expect((await step(b.user, orderId, 1, "loaded")).error).toMatchObject({ details: "wrong_step:1:arrived_pickup" });
    await doLeg(b.user, orderId, 1);
    expect((await complete(b.user, orderId, "Lucia", await signature(b.user, orderId))).error).toBeNull();
    const legs = await check(service.from("order_legs").select("leg_index, porters_worked_minutes").eq("order_id", orderId).order("leg_index"));
    expect(legs.map((l) => l.porters_worked_minutes)).toEqual([0, 0]);
  });

  it("removed while the goods are in the warehouse (leg 1 unloaded, leg 2 not loaded): da gestire on leg 2, never back to paid (D136)", async () => {
    const orderId = await paidOrder({ hoursAhead: 72, storage: true });
    const a = await activeCarrier();
    await check(accept(a.user, orderId, a.vehicleId));
    pickupToday(orderId);
    await doLeg(a.user, orderId, 0);
    await run(step(a.user, orderId, 1, "arrived_pickup"));
    const historyBefore = await check(customer.client.from("order_status_history").select("from_status, to_status").eq("order_id", orderId));
    const customerBefore = await check(customer.client.from("orders").select("status, picked_up_at, in_transit_at").eq("id", orderId).single());

    await run(unassign(orderId));
    expect(await flags(orderId)).toMatchObject({ status: "in_transit", carrier_id: null, handover_leg_index: 1 });
    // the customer sees exactly the same: no status going back, no history row
    expect(await check(customer.client.from("orders").select("status, picked_up_at, in_transit_at").eq("id", orderId).single())).toEqual(customerBefore);
    expect(await check(customer.client.from("order_status_history").select("from_status, to_status").eq("order_id", orderId))).toEqual(historyBefore);
    // leg 1 kept, leg 2's arrival reverted; audit says why, without free text
    const live = await check(service.from("order_leg_steps").select("leg_index, step").eq("order_id", orderId).is("reverted_at", null));
    expect(live.every((s) => s.leg_index === 0)).toBe(true);
    expect(live).toHaveLength(5);
    const audit = await check(service.from("audit_log").select("data").eq("entity_id", orderId).eq("action", "order.unassigned"));
    expect(audit.at(-1)?.data).toMatchObject({ handover_reason: "in_warehouse", handover_leg_index: 1, goods_loaded: false, from: "in_transit" });
    // not on the list, not acceptable
    const c = await activeCarrier();
    expect(await listedIds(c.user)).not.toContain(orderId);

    // the admin assigns a new carrier with the warehouse address; it starts leg 2 (from its pickup day — today here)
    const b = await activeCarrier();
    await run(handover(orderId, b.user.id, b.vehicleId, "Magazzino Transigo, Via Toffetti 20, Milano", "Padroncino in malattia"));
    expect((await step(b.user, orderId, 1, "loaded")).error).toMatchObject({ details: "wrong_step:1:arrived_pickup" });
    await doLeg(b.user, orderId, 1);
    expect((await complete(b.user, orderId, "Lucia", await signature(b.user, orderId))).error).toBeNull();
    expect((await flags(orderId)).status).toBe("delivered");
  });

  it("every leg unloaded but no POD: «Rimuovi padroncino» refused (all_unloaded), nothing changes", async () => {
    const { orderId, c } = await runningJob();
    await doLeg(c.user, orderId, 0);
    expect((await unassign(orderId)).error).toMatchObject({ code: "55000", details: "all_unloaded" });
    expect(await flags(orderId)).toMatchObject({ status: "in_transit", carrier_id: c.user.id, handover_required_at: null });
    // the carrier can still confirm the delivery
    expect((await complete(c.user, orderId, "Lucia", await signature(c.user, orderId))).error).toBeNull();
  });

  it("load on board: audit handover_reason 'on_board' (unchanged behaviour)", async () => {
    const { orderId } = await loadedJob();
    await run(unassign(orderId));
    const audit = await check(service.from("audit_log").select("data").eq("entity_id", orderId).eq("action", "order.unassigned"));
    expect(audit.at(-1)?.data).toMatchObject({ handover_reason: "on_board", handover_leg_index: 0, goods_loaded: true });
  });

  it("after a takeover on leg 2: undoing the new carrier's loaded / departed never lowers the status (D136)", async () => {
    const orderId = await paidOrder({ hoursAhead: 72, storage: true });
    const a = await activeCarrier();
    await check(accept(a.user, orderId, a.vehicleId));
    pickupToday(orderId);
    await doLeg(a.user, orderId, 0);
    await run(unassign(orderId));
    const b = await activeCarrier();
    await run(handover(orderId, b.user.id, b.vehicleId, "Magazzino Transigo", "Cambio padroncino"));
    await run(step(b.user, orderId, 1, "arrived_pickup"));
    await photo(b.user, orderId, 1, "pickup");
    await run(step(b.user, orderId, 1, "loaded"));
    await run(step(b.user, orderId, 1, "departed"));
    const before = await flags(orderId);
    const revert = (s: string) => service.rpc("admin_revert_last_step", { p_order_id: orderId, p_admin_id: admin.id, p_leg_index: 1, p_step: s, p_reason: "Errore" })
      .single<{ order_status: string }>();
    expect((await revert("departed")).data?.order_status).toBe("in_transit");
    expect((await revert("loaded")).data?.order_status).toBe("in_transit");
    expect(await flags(orderId)).toMatchObject({ status: "in_transit", picked_up_at: before.picked_up_at });
    // no status history row from these undos
    expect((await historyRows(orderId)).filter((r) => r.source === "admin_panel" && r.to_status !== "paid")).toHaveLength(0);
  });
});

describe("server code behind /admin/ordini (dispatch-server.assignHandover)", () => {
  it("validates, assigns, sends order_assigned with the new carrier; Italian messages", async () => {
    const srv = await import("@/lib/orders/dispatch-server");
    const { DISPATCH_MSG } = await import("@/lib/orders/dispatch");
    const deps = { admin: { userId: admin.id, email: admin.email }, serviceDb: service, appUrl: "https://transigo.example" };
    const { orderId } = await loadedJob();
    const next = await activeCarrier();
    const candidate = `${next.user.id}:${next.vehicleId}`;
    expect(await srv.assignHandover(deps, { orderId, candidate, address: "Via X 1", reason: "x" })).toEqual({ ok: false, error: DISPATCH_MSG.notHandover });
    await run(unassign(orderId));
    expect(await srv.assignHandover(deps, { orderId, candidate, address: "  ", reason: "x" })).toEqual({ ok: false, error: DISPATCH_MSG.addressRequired });
    expect(await srv.assignHandover(deps, { orderId, candidate, address: "Via X 1", reason: "" })).toEqual({ ok: false, error: DISPATCH_MSG.handoverReasonRequired });
    expect(await srv.assignHandover(deps, { orderId, candidate: "x", address: "Via X 1", reason: "x" })).toEqual({ ok: false, error: DISPATCH_MSG.chooseCandidate });

    const mails = async () => check(service.from("email_outbox").select("template_code, text_body").eq("order_id", orderId).eq("template_code", "order_assigned").order("created_at"));
    const before = (await mails()).length;
    expect(await srv.assignHandover(deps, { orderId, candidate, address: "Deposito Rossi, Lodi", reason: "Furgone in panne" })).toEqual({ ok: true, message: DISPATCH_MSG.handoverAssigned });
    const after = await mails();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.text_body).not.toContain("Deposito"); // the address is not for the customer
    expect(after.at(-1)!.text_body).not.toContain("panne");
  });
});

