import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAdminExecution, loadCustomerExecution } from "@/lib/orders/execution-read";
import { EXEC_ADMIN_MSG } from "@/lib/orders/execution-view";
import { allowEarlyStart, revertLastStep } from "@/lib/orders/dispatch-server";
import { createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";
import { check, run, setupJobContext, teardownJobContext } from "./job-fixtures";
import { complete, doLeg, order, photo, runningJob, signature, step } from "./execution-fixtures";

// Proof of delivery and job execution as the CUSTOMER and the ADMIN see them (src/lib/orders/execution-read.ts —
// only the caller's own session) and the admin corrections behind /admin/ordini/[id] (dispatch-server.ts:
// revertLastStep, allowEarlyStart) on the LOCAL database (D64).

let admin: TestUser;
let customer: TestUser;
let otherCustomer: TestUser;

const deps = () => ({ admin: { userId: admin.id, email: admin.email }, serviceDb: service, appUrl: "https://transigo.example" });

/** The order as the customer page loads it (customer session). */
async function customerOrder(u: TestUser, orderId: string) {
  return check(u.client.from("orders").select("id, status, order_legs(leg_index, porters_count, porters_included_hours)").eq("id", orderId).maybeSingle()) as Promise<{
    id: string; status: string; order_legs: { leg_index: number; porters_count: number; porters_included_hours: number | null }[];
  }>;
}

async function adminOrder(orderId: string) {
  return check(admin.client.from("orders").select("id, order_legs(leg_index, porters_count, porters_included_hours, porter_overtime_grace_minutes)").eq("id", orderId).single()) as Promise<{
    id: string; order_legs: { leg_index: number; porters_count: number; porters_included_hours: number | null; porter_overtime_grace_minutes: number | null }[];
  }>;
}

/** A job delivered by its carrier with POD; steps carry a position. */
async function deliveredJob() {
  const { orderId, c } = await runningJob();
  await step(c.user, orderId, 0, "arrived_pickup", 45.46, 9.19);
  await doLeg(c.user, orderId, 0); // the first step is already there: doLeg records the rest (same step = no error)
  const path = await signature(c.user, orderId);
  const r = await complete(c.user, orderId, "Anna Verdi", path, 45.07, 7.68);
  expect(r.error).toBeNull();
  return { orderId, c, signaturePath: path };
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

describe("customer: «Prova di consegna»", () => {
  it("after the delivery: recipient, time, working signature and photo URLs, porter time — no positions or ids", async () => {
    const { orderId } = await deliveredJob();
    const view = await loadCustomerExecution(customer.client, await customerOrder(customer, orderId));

    expect(view.proof).toMatchObject({ recipientName: "Anna Verdi", signatureUrl: expect.stringContaining("/pod-signatures/") });
    expect(view.photos.map((p) => p.kind).sort()).toEqual(["delivery", "pickup"]);
    for (const p of view.photos) expect(p.url).toEqual(expect.stringContaining("/order-photos/"));
    expect((await fetch(view.proof!.signatureUrl!)).status).toBe(200);
    expect((await fetch(view.photos[0].url!)).status).toBe(200);
    expect(view.porters).toEqual([{ legIndex: 0, workedLabel: expect.any(String), includedLabel: "1 h", complete: true }]);

    const json = JSON.stringify(view);
    expect(json).not.toMatch(/"lat"|"lng"|45\.46|45\.07|createdBy|storage_path/);
  });

  it("before the delivery: no POD; pickup photos only once loaded", async () => {
    const { orderId, c } = await runningJob();
    await step(c.user, orderId, 0, "arrived_pickup");
    expect((await photo(c.user, orderId, 0, "pickup")).error).toBeNull();

    let view = await loadCustomerExecution(customer.client, await customerOrder(customer, orderId));
    expect(view.photos).toEqual([]); // still "assigned"
    expect(view.proof).toBeNull();

    expect((await step(c.user, orderId, 0, "loaded")).error).toBeNull();
    view = await loadCustomerExecution(customer.client, await customerOrder(customer, orderId));
    expect((await order(orderId)).status).toBe("picked_up");
    expect(view.photos.map((p) => p.kind)).toEqual(["pickup"]);
    expect(view.porters[0]).toMatchObject({ legIndex: 0, complete: false });
  });

  it("another customer: no order, no rows, no signed URL of the files", async () => {
    const { orderId, signaturePath } = await deliveredJob();
    expect(await otherCustomer.client.from("orders").select("id").eq("id", orderId)).toMatchObject({ data: [] });
    const photos = await check(service.from("order_photos").select("storage_path").eq("order_id", orderId));

    // what loadCustomerExecution would do with a forged order: RLS leaves nothing to sign
    const forged = await loadCustomerExecution(otherCustomer.client, { id: orderId, status: "delivered", order_legs: [{ leg_index: 0, porters_count: 2, porters_included_hours: 1 }] });
    expect(forged.photos).toEqual([]);
    expect(forged.proof).toBeNull();
    expect(forged.porters).toEqual([]);

    const p = await otherCustomer.client.storage.from("order-photos").createSignedUrl(photos[0].storage_path, 300);
    expect(p.data?.signedUrl ?? null).toBeNull();
    const s = await otherCustomer.client.storage.from("pod-signatures").createSignedUrl(signaturePath, 300);
    expect(s.data?.signedUrl ?? null).toBeNull();
  });

  it("the customer reads no admin notes and no admin execution data", async () => {
    const { orderId, c } = await runningJob();
    await step(c.user, orderId, 0, "arrived_pickup", 45.46, 9.19);
    expect(await revertLastStep(deps(), { orderId, leg: "0", step: "arrived_pickup", reason: "Arrivo segnato per errore" })).toMatchObject({ ok: true });

    expect(await customer.client.from("order_admin_notes").select("id").eq("order_id", orderId)).toMatchObject({ data: [] });
    expect((await customer.client.rpc("admin_order_execution", { p_order_id: orderId })).error?.code).toBe("42501");
    expect((await customer.client.rpc("admin_delivery_proof", { p_order_id: orderId })).error?.code).toBe("42501");
    expect((await customer.client.from("order_leg_steps").select("lat").eq("order_id", orderId)).error).not.toBeNull();
  });
});

describe("admin: execution, corrections, notes", () => {
  it("steps with positions and who, POD with position, photos and signature URLs, porter time", async () => {
    const { orderId, c } = await deliveredJob();
    const view = await loadAdminExecution(admin.client, await adminOrder(orderId));

    expect(view.steps.map((s) => s.step)).toEqual(["arrived_pickup", "loaded", "departed", "arrived_delivery", "unloaded"]);
    expect(view.steps[0]).toMatchObject({ lat: 45.46, lng: 9.19, createdBy: c.user.id, revertedAt: null });
    expect(view.proof).toMatchObject({ recipientName: "Anna Verdi", lat: 45.07, lng: 7.68, createdBy: c.user.id, signatureUrl: expect.any(String) });
    expect(view.photos).toHaveLength(2);
    expect(view.photos.every((p) => p.url)).toBe(true);
    expect(view.porters).toEqual([expect.objectContaining({ legIndex: 0, complete: true })]);
    expect(view.actorIds).toEqual([c.user.id]);
  });

  it("a non-admin session cannot use the admin loader", async () => {
    const { orderId } = await runningJob();
    await expect(loadAdminExecution(customer.client, { id: orderId, order_legs: [] })).rejects.toThrow("execution unavailable");
  });

  it("«Annulla ultimo passo»: only the step the admin saw; status back; reason in the notes", async () => {
    const { orderId, c } = await runningJob();
    await step(c.user, orderId, 0, "arrived_pickup");
    expect((await photo(c.user, orderId, 0, "pickup")).error).toBeNull();
    await step(c.user, orderId, 0, "loaded");
    expect((await order(orderId)).status).toBe("picked_up");

    // the admin page showed "arrived_pickup" as last — meanwhile the carrier recorded "loaded"
    expect(await revertLastStep(deps(), { orderId, leg: "0", step: "arrived_pickup", reason: "x" })).toEqual({ ok: false, error: EXEC_ADMIN_MSG.changed });
    expect(await revertLastStep(deps(), { orderId, leg: "0", step: "loaded", reason: "  " })).toEqual({ ok: false, error: EXEC_ADMIN_MSG.reasonRequired });
    expect(await revertLastStep(deps(), { orderId, leg: "0", step: "loaded", reason: "Carico segnato prima del tempo" }))
      .toEqual({ ok: true, message: EXEC_ADMIN_MSG.reverted("Carico completato") });
    expect((await order(orderId)).status).toBe("assigned");

    const view = await loadAdminExecution(admin.client, await adminOrder(orderId));
    expect(view.steps.find((s) => s.step === "loaded")).toMatchObject({ revertedBy: admin.id });
    expect(view.notes).toEqual([expect.objectContaining({ kind: "step_reverted", legIndex: 0, body: "Carico segnato prima del tempo", createdBy: admin.id })]);
    expect(view.actorIds.sort()).toEqual([admin.id, c.user.id].sort());

    // the carrier can record the step again
    expect((await step(c.user, orderId, 0, "loaded")).error).toBeNull();
  });

  it("«Annulla ultimo passo» with nothing to undo / after delivery", async () => {
    const { orderId } = await runningJob();
    expect(await revertLastStep(deps(), { orderId, leg: "0", step: "arrived_pickup", reason: "x" })).toEqual({ ok: false, error: EXEC_ADMIN_MSG.noStep });
    const done = await deliveredJob();
    expect(await revertLastStep(deps(), { orderId: done.orderId, leg: "0", step: "unloaded", reason: "x" })).toEqual({ ok: false, error: EXEC_ADMIN_MSG.notInProgress });
  });

  it("«Consenti inizio anticipato»: the carrier may start before the pickup day; twice = already allowed", async () => {
    const { orderId, c } = await runningJob({}, false); // pickup in 3 days
    expect((await step(c.user, orderId, 0, "arrived_pickup")).error).toMatchObject({ details: "too_early" });
    expect(await allowEarlyStart(deps(), { orderId, leg: "0", reason: "" })).toEqual({ ok: false, error: EXEC_ADMIN_MSG.reasonRequired });
    expect(await allowEarlyStart(deps(), { orderId, leg: "0", reason: "Il cliente è pronto oggi" })).toEqual({ ok: true, message: EXEC_ADMIN_MSG.earlyStartAllowed });
    expect(await allowEarlyStart(deps(), { orderId, leg: "0", reason: "di nuovo" })).toEqual({ ok: true, message: EXEC_ADMIN_MSG.earlyStartAlready });
    expect((await step(c.user, orderId, 0, "arrived_pickup")).error).toBeNull();

    const notes = (await loadAdminExecution(admin.client, await adminOrder(orderId))).notes;
    expect(notes).toEqual([expect.objectContaining({ kind: "early_start", legIndex: 0, body: "Il cliente è pronto oggi" })]);
  });

  it("«Consenti inizio anticipato» on an unknown leg", async () => {
    const { orderId } = await runningJob({}, false);
    expect(await allowEarlyStart(deps(), { orderId, leg: "1", reason: "x" })).toEqual({ ok: false, error: EXEC_ADMIN_MSG.notFound });
  });
});
