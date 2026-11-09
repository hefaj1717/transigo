import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteCreatedUsers, service, type TestUser } from "./helpers";
import { activeCarrier, check, orderRow, paidOrder, run, setupJobContext, teardownJobContext } from "./job-fixtures";
import {
  acceptJob, listAvailableJobs, loadAvailableJob, loadEligibility, loadMyJob, loadMyJobs, releaseJob, type JobNotifyDeps,
} from "@/lib/carriers/jobs-server";
import { JOB_MSG } from "@/lib/carriers/jobs";

// Carrier job screens — server logic (src/lib/carriers/jobs-server.ts) on the LOCAL database (D64):
// reads and RPCs with the carrier's session; the service role only queues e-mails after a successful RPC;
// e-mail failures never undo an accept / release (D119–D121, D116).

const ADMIN_EMAIL = "ops-jobs@transigo.test";
const APP_URL = "https://transigo.example";

let admin: TestUser;
let customer: TestUser;

/** Service-role factory that counts how often it was asked for (= how often the server wanted to send e-mails). */
function notifyDeps(opts: { adminEmail?: string | null; serviceDb?: SupabaseClient } = {}) {
  const calls = { serviceDb: 0 };
  const deps: JobNotifyDeps = {
    serviceDb: () => {
      calls.serviceDb++;
      return opts.serviceDb ?? service;
    },
    adminEmail: opts.adminEmail === undefined ? ADMIN_EMAIL : opts.adminEmail,
    appUrl: APP_URL,
  };
  return { deps, calls };
}

/** A "service client" whose every call fails — the e-mail cannot be queued. */
const brokenServiceDb = new Proxy({} as SupabaseClient, {
  get: () => () => {
    throw new Error("outbox down");
  },
});

const assignedMails = (orderId: string) =>
  check(service.from("email_outbox").select("to_address, text_body").eq("template_code", "order_assigned").eq("order_id", orderId));
const releaseMails = (orderNumber: string) =>
  check(service.from("email_outbox").select("to_address, subject, text_body, html, order_id, status").eq("template_code", "carrier_released_job").ilike("subject", `%${orderNumber}%`).order("created_at"));
const orderNumber = async (id: string) => (await check(service.from("orders").select("order_number").eq("id", id).single())).order_number as string;

const suspend = (carrierId: string) =>
  run(service.rpc("set_carrier_suspension", { p_carrier_id: carrierId, p_admin_id: admin.id, p_suspend: true, p_reason: "Controllo" }));

// What the customer typed or what identifies them (fixtures in job-fixtures.ts).
const PERSONAL = ["Via Roma", "Via Po", "Mario", "Rossi", "Lucia", "Bianchi", "+39", "Divano", "Citofono", "45.46", "place-pickup", "19520"];

beforeAll(async () => {
  ({ admin, customer } = await setupJobContext());
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await service.from("email_outbox").delete().eq("to_address", ADMIN_EMAIL);
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

// ---------------------------------------------------------------------------

describe("before accepting: no streets, contacts or notes (D119)", () => {
  it("list and job page: cities, km and the carrier amount only; nothing personal", async () => {
    const orderId = await paidOrder({ item: [120, 80, 60] });
    const c = await activeCarrier();

    const list = await listAvailableJobs(c.user.client);
    expect(list.ok).toBe(true);
    const card = list.ok ? list.jobs.find((j) => j.orderId === orderId) : undefined;
    expect(card).toMatchObject({
      stops: [{ city: "Milano", province: "MI", isWarehouse: false }, { city: "Torino", province: "TO", isWarehouse: false }],
      distanceM: 143_122,
      amount: { totalCents: 11_800, transportCents: 7_000, portersCents: 4_800, packingCents: 0 },
      matchingVehicleIds: [c.vehicleId],
    });

    const page = await loadAvailableJob(c.user.client, c.user.id, orderId);
    expect(page.kind).toBe("available");
    if (page.kind !== "available") return;
    expect(page.vehicles).toEqual([{ id: c.vehicleId, plate: expect.any(String), vehicleTypeName: expect.any(String) }]);
    expect(page.overlaps).toEqual([]);

    const text = JSON.stringify([list, page]);
    for (const secret of PERSONAL) expect(text).not.toContain(secret);
    expect(await loadMyJob(c.user.client, c.user.id, orderId)).toBeNull();
  });

  it("after accepting: the full job with addresses, contacts and notes", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    expect(await acceptJob(c.user.client, orderId, c.vehicleId, notifyDeps().deps)).toEqual({ ok: true, newlyAssigned: true, message: JOB_MSG.accepted });

    const job = await loadMyJob(c.user.client, c.user.id, orderId);
    expect(job).toMatchObject({
      orderId, status: "assigned", tab: "da-fare", statusLabel: "Da ritirare",
      goodsDescription: "Divano di Mario Rossi e 5 scatoloni",
      customerNotes: "Citofono Rossi, scala B",
      pickupContact: { name: "Mario Rossi", phone: "+393331234567" },
      deliveryContact: { name: "Lucia Bianchi", phone: "+393337654321" },
      addresses: [{ legIndex: 0, pickupAddress: "Via Roma 1, 20121 Milano MI", deliveryAddress: "Via Po 2, 10124 Torino TO" }],
      vehicle: { id: c.vehicleId },
      amount: { totalCents: 11_800 },
      release: { allowed: true },
    });
    // The customer price is never in the carrier's view (D29).
    expect(JSON.stringify(job)).not.toMatch(/19520|16000|total_cents/);

    expect((await loadMyJobs(c.user.client, c.user.id)).map((j) => j.orderId)).toEqual([orderId]);
    // The job page of an accepted job says "already yours" instead of showing it as available.
    expect(await loadAvailableJob(c.user.client, c.user.id, orderId)).toEqual({ kind: "mine" });
  });

  it("another carrier's job: not in my jobs, not readable, unavailable", async () => {
    const orderId = await paidOrder();
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    await acceptJob(a.user.client, orderId, a.vehicleId, notifyDeps().deps);
    expect(await loadMyJob(b.user.client, b.user.id, orderId)).toBeNull();
    expect(await loadMyJobs(b.user.client, b.user.id)).toEqual([]);
    expect(await loadAvailableJob(b.user.client, b.user.id, orderId)).toEqual({ kind: "unavailable" });
    // a user id that is not the session's does not widen anything (RLS still applies)
    expect(await loadMyJob(b.user.client, a.user.id, orderId)).toBeNull();
  });
});

describe("Accetta la Corsa → order_assigned to the customer", () => {
  it("one e-mail to the customer in the outbox, the service role used only after the RPC", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    const { deps, calls } = notifyDeps();
    expect(await acceptJob(c.user.client, orderId, c.vehicleId, deps)).toMatchObject({ ok: true, newlyAssigned: true });
    expect(calls.serviceDb).toBe(1);
    const mails = await assignedMails(orderId);
    expect(mails).toHaveLength(1);
    expect(mails[0].to_address).toBe(customer.email);
    expect(mails[0].text_body).toContain(`${APP_URL}/cliente/ordini/${orderId}`);
  });

  it("refused accept: no service role at all", async () => {
    const orderId = await paidOrder({ weightKg: 5_000 }); // too heavy for every test vehicle → not listed
    const c = await activeCarrier();
    const { deps, calls } = notifyDeps();
    const r = await acceptJob(c.user.client, orderId, c.vehicleId, deps);
    expect(r.ok).toBe(false);
    expect(calls.serviceDb).toBe(0);
    expect(await assignedMails(orderId)).toEqual([]);
  });

  it("accepting twice (double click): newly_assigned = false, 'già accettata da te', no second e-mail", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await acceptJob(c.user.client, orderId, c.vehicleId, notifyDeps().deps);

    const { deps, calls } = notifyDeps();
    const again = await acceptJob(c.user.client, orderId, c.vehicleId, deps);
    expect(again).toEqual({ ok: true, newlyAssigned: false, message: JOB_MSG.alreadyMine });
    expect(again).not.toMatchObject({ message: JOB_MSG.alreadyTaken });
    expect(calls.serviceDb).toBe(0); // the e-mail is not even attempted (not just deduplicated by the outbox)
    expect(await assignedMails(orderId)).toHaveLength(1);

    // the same in parallel (two tabs)
    const orderId2 = await paidOrder();
    const both = await Promise.all([1, 2].map(() => acceptJob(c.user.client, orderId2, c.vehicleId, notifyDeps().deps)));
    expect(both.map((r) => r.ok && r.newlyAssigned).sort()).toEqual([false, true]);
    expect(await assignedMails(orderId2)).toHaveLength(1);
  });

  it("two carriers at once: one wins, the other gets already_taken and a list refresh; one e-mail", async () => {
    const orderId = await paidOrder();
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    const results = await Promise.all([a, b].map((c) => acceptJob(c.user.client, orderId, c.vehicleId, notifyDeps().deps)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: JOB_MSG.alreadyTaken, refreshList: true });
    expect(await assignedMails(orderId)).toHaveLength(1);
  });

  it("an e-mail failure does not undo the acceptance; the error is logged", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await acceptJob(c.user.client, orderId, c.vehicleId, notifyDeps({ serviceDb: brokenServiceDb }).deps);
    expect(r).toEqual({ ok: true, newlyAssigned: true, message: JOB_MSG.accepted });
    expect(await orderRow(orderId)).toMatchObject({ status: "assigned", carrier_id: c.user.id });
    expect(log).toHaveBeenCalledWith("[jobs] order_assigned e-mail failed", expect.objectContaining({ orderId }));
  });

  it("invalid ids never reach the database", async () => {
    const c = await activeCarrier();
    const { deps, calls } = notifyDeps();
    expect(await acceptJob(c.user.client, "x", c.vehicleId, deps)).toEqual({ ok: false, error: JOB_MSG.notFound, refreshList: true });
    expect(await acceptJob(c.user.client, c.vehicleId, "", deps)).toEqual({ ok: false, error: JOB_MSG.chooseVehicle, refreshList: false });
    expect(calls.serviceDb).toBe(0);
  });
});

describe("Rinuncia → e-mail to the Transigo team (D121)", () => {
  it("released: back to the list, one e-mail to the admin without customer data; every release sends one", async () => {
    const orderId = await paidOrder();
    const number = await orderNumber(orderId);
    const [c, other] = await Promise.all([activeCarrier(), activeCarrier()]);
    await acceptJob(c.user.client, orderId, c.vehicleId, notifyDeps().deps);

    const { deps, calls } = notifyDeps();
    expect(await releaseJob(c.user.client, c.user.id, orderId, deps)).toEqual({ ok: true, message: JOB_MSG.released });
    expect(calls.serviceDb).toBe(1);
    expect(await orderRow(orderId)).toMatchObject({ status: "paid", carrier_id: null });
    const list = await listAvailableJobs(other.user.client);
    expect(list.ok && list.jobs.map((j) => j.orderId)).toContain(orderId);

    let mails = await releaseMails(number);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to_address: ADMIN_EMAIL, status: "captured_dev", order_id: null, subject: `Rinuncia alla corsa ${number} – Trasporti Corse Srl` });
    expect(mails[0].text_body).toContain(`${APP_URL}/admin/ordini/${orderId}`);
    expect(mails[0].text_body).toContain("Ritiro previsto:");
    for (const secret of PERSONAL) expect(`${mails[0].text_body}${mails[0].html}`).not.toContain(secret);

    // accepted and released again (within 15 min): a second e-mail
    await acceptJob(c.user.client, orderId, c.vehicleId, notifyDeps().deps);
    await releaseJob(c.user.client, c.user.id, orderId, notifyDeps().deps);
    mails = await releaseMails(number);
    expect(mails).toHaveLength(2);
  });

  it("without ADMIN_NOTIFICATION_EMAIL the release goes through; the error is logged, no service role", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await acceptJob(c.user.client, orderId, c.vehicleId, notifyDeps().deps);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, calls } = notifyDeps({ adminEmail: null });
    expect(await releaseJob(c.user.client, c.user.id, orderId, deps)).toEqual({ ok: true, message: JOB_MSG.released });
    expect((await orderRow(orderId)).status).toBe("paid");
    expect(calls.serviceDb).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ADMIN_NOTIFICATION_EMAIL not set"), { orderId });
    expect(await releaseMails(await orderNumber(orderId))).toEqual([]);
  });

  it("an outbox failure does not undo the release; the error is logged", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await acceptJob(c.user.client, orderId, c.vehicleId, notifyDeps().deps);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await releaseJob(c.user.client, c.user.id, orderId, notifyDeps({ serviceDb: brokenServiceDb }).deps)).toEqual({ ok: true, message: JOB_MSG.released });
    expect((await orderRow(orderId)).status).toBe("paid");
    expect(log).toHaveBeenCalledWith("[jobs] carrier_released_job e-mail failed", expect.objectContaining({ orderId }));
  });

  it("too late (after 15 min and < 48 h before pickup): refused, no e-mail, no service role", async () => {
    const orderId = await paidOrder({ hoursAhead: 30 });
    const c = await activeCarrier();
    await acceptJob(c.user.client, orderId, c.vehicleId, notifyDeps().deps);
    await run(service.from("orders").update({ assigned_at: new Date(Date.now() - 16 * 60_000).toISOString() }).eq("id", orderId));
    expect((await loadMyJob(c.user.client, c.user.id, orderId))?.release).toMatchObject({ allowed: false, reason: "expired" });

    const { deps, calls } = notifyDeps();
    expect(await releaseJob(c.user.client, c.user.id, orderId, deps)).toEqual({ ok: false, error: JOB_MSG.releaseTooLate });
    expect(calls.serviceDb).toBe(0);
    expect((await orderRow(orderId)).status).toBe("assigned");
    expect(await releaseMails(await orderNumber(orderId))).toEqual([]);
  });

  it("someone else's job: not_assigned, nothing changes", async () => {
    const orderId = await paidOrder();
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    await acceptJob(a.user.client, orderId, a.vehicleId, notifyDeps().deps);
    const { deps, calls } = notifyDeps();
    expect(await releaseJob(b.user.client, b.user.id, orderId, deps)).toEqual({ ok: false, error: JOB_MSG.notAssigned });
    expect(calls.serviceDb).toBe(0);
    expect(await orderRow(orderId)).toMatchObject({ status: "assigned", carrier_id: a.user.id });
  });
});

describe("suspended carrier (D116)", () => {
  it("sees its own jobs and may release them, but gets no list of available jobs", async () => {
    const [kept, released] = [await paidOrder(), await paidOrder()];
    const c = await activeCarrier();
    await acceptJob(c.user.client, kept, c.vehicleId, notifyDeps().deps);
    await acceptJob(c.user.client, released, c.vehicleId, notifyDeps().deps);
    await suspend(c.user.id);

    expect((await loadMyJobs(c.user.client, c.user.id)).map((j) => j.orderId).sort()).toEqual([kept, released].sort());
    expect(await loadMyJob(c.user.client, c.user.id, kept)).toMatchObject({ orderId: kept, pickupContact: { name: "Mario Rossi" } });

    const list = await listAvailableJobs(c.user.client);
    expect(list).toEqual({ ok: false, blockers: [expect.objectContaining({ code: "carrier_not_active" })] });
    expect((await loadEligibility(c.user.client)).blockers.map((b) => b.code)).toEqual(["carrier_not_active"]);
    expect(await loadAvailableJob(c.user.client, c.user.id, await paidOrder())).toMatchObject({ kind: "blocked" });

    const fresh = await paidOrder();
    const refused = await acceptJob(c.user.client, fresh, c.vehicleId, notifyDeps().deps);
    expect(refused).toEqual({ ok: false, error: JOB_MSG.notEligible, refreshList: true });

    expect(await releaseJob(c.user.client, c.user.id, released, notifyDeps().deps)).toEqual({ ok: true, message: JOB_MSG.released });
    expect(await releaseMails(await orderNumber(released))).toHaveLength(1);
    expect((await loadMyJobs(c.user.client, c.user.id)).map((j) => j.orderId)).toEqual([kept]);
  });
});
