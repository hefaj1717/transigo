import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteCreatedUsers, service, type TestUser } from "./helpers";
import { activeCarrier, check, paidOrder, run, setupJobContext, teardownJobContext } from "./job-fixtures";
import { paidPortersOrder, PORTERS_PERSONAL } from "./porters-fixtures";
import { acceptPorterJob, listAvailableJobs, loadAvailableJob, loadMyJob, loadMyJobs, releaseJob, type JobNotifyDeps } from "@/lib/carriers/jobs-server";
import { JOB_MSG } from "@/lib/carriers/jobs";
import { setCarrierPorters } from "@/lib/carriers/admin-server";
import { advanceOrder, assignPortersJob, loadPorterCandidates, unassignJob } from "@/lib/orders/dispatch-server";
import { DISPATCH_MSG } from "@/lib/orders/dispatch";

// Facchinaggio screens — server code of step 6e on the LOCAL database (D64): the carrier's list and job pages
// (jobs-server.ts, carrier session), "Accetta" without a vehicle, "Le mie corse", the release e-mail, and the
// admin's candidates / assignment / statuses / carrier settings (dispatch-server.ts, admin-server.ts).

const AREA = "BO";
const ADMIN_EMAIL = "ops-porters@transigo.test";
const APP_URL = "https://transigo.example";

let admin: TestUser;
let customer: TestUser;

const notify: JobNotifyDeps = { serviceDb: () => service, adminEmail: ADMIN_EMAIL, appUrl: APP_URL };
const adminDeps = () => ({ admin: { userId: admin.id, email: admin.email }, serviceDb: service, appUrl: APP_URL });
const paidPorters = (o: { persons?: number; hoursAhead?: number } = {}) => paidPortersOrder(customer.id, AREA, o);

async function portersCarrier(team = 2) {
  const c = await activeCarrier();
  await run(service.rpc("admin_set_carrier_porters", { p_carrier_id: c.user.id, p_admin_id: admin.id, p_offers: true, p_team_size: team }));
  return c;
}

beforeAll(async () => {
  ({ admin, customer } = await setupJobContext());
  await run(service.from("service_area_provinces").update({ is_active: true }).eq("province_code", AREA));
});

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_URL));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await service.from("service_area_provinces").update({ is_active: false }).eq("province_code", AREA);
  await service.from("email_outbox").delete().eq("to_address", ADMIN_EMAIL);
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("carrier: Corse disponibili with Facchinaggio", () => {
  it("one list for transport and porter jobs, by start; porter cards have the team, no route, nothing personal", async () => {
    const porters = await paidPorters({ hoursAhead: 50 });
    const transport = await paidOrder({ hoursAhead: 60 });
    const c = await portersCarrier();
    const result = await listAvailableJobs(c.user.client);
    if (!result.ok) throw new Error("blocked");
    const ids = result.jobs.map((j) => j.orderId);
    expect(ids).toEqual(expect.arrayContaining([porters, transport]));
    expect(ids.indexOf(porters)).toBeLessThan(ids.indexOf(transport));
    const card = result.jobs.find((j) => j.orderId === porters)!;
    expect(card).toMatchObject({ legs: [], distanceM: 0, porters: { persons: 2, hours: 2, floor: "3° piano, senza ascensore" }, amount: { totalCents: 9_600, portersCents: 9_600 } });
    expect(card.stops).toEqual([{ city: "Bologna", province: AREA, isWarehouse: false }]);
    const text = JSON.stringify(card);
    for (const secret of PORTERS_PERSONAL) expect(text).not.toContain(secret);
  });

  it("a carrier without facchinaggio sees transport only; the porter job page says unavailable", async () => {
    const porters = await paidPorters();
    const c = await activeCarrier();
    const result = await listAvailableJobs(c.user.client);
    if (!result.ok) throw new Error("blocked");
    expect(result.jobs.map((j) => j.orderId)).not.toContain(porters);
    expect((await loadAvailableJob(c.user.client, c.user.id, porters)).kind).toBe("unavailable");
  });

  it("job page: available without vehicles; accept without a vehicle → mine, order_assigned e-mail once", async () => {
    const porters = await paidPorters();
    const c = await portersCarrier();
    const page = await loadAvailableJob(c.user.client, c.user.id, porters);
    expect(page).toMatchObject({ kind: "available", vehicles: [], job: { porters: { persons: 2 } } });
    expect(JSON.stringify(page)).not.toContain("Indipendenza");

    const first = await acceptPorterJob(c.user.client, c.user.id, porters, notify);
    expect(first).toEqual({ ok: true, newlyAssigned: true, message: JOB_MSG.accepted });
    const again = await acceptPorterJob(c.user.client, c.user.id, porters, notify);
    expect(again).toEqual({ ok: true, newlyAssigned: false, message: JOB_MSG.alreadyMine });
    expect((await check(service.from("email_outbox").select("subject").eq("template_code", "order_assigned").eq("order_id", porters))).map((m) => m.subject))
      .toEqual([expect.stringMatching(/^Facchini assegnati/)]);
    expect((await loadAvailableJob(c.user.client, c.user.id, porters)).kind).toBe("mine");
  });

  it("team too small → Italian message and back to the list", async () => {
    const porters = await paidPorters({ persons: 3 });
    const c = await portersCarrier(2);
    expect(await acceptPorterJob(c.user.client, c.user.id, porters, notify)).toEqual({ ok: false, error: JOB_MSG.teamNotSuitable, refreshList: true });
  });
});

describe("carrier: Le mie corse with Facchinaggio", () => {
  it("summary and detail: team, porters labels, full address and contact only after accepting", async () => {
    const porters = await paidPorters();
    const c = await portersCarrier();
    expect(await loadMyJob(c.user.client, c.user.id, porters)).toBeNull();
    await acceptPorterJob(c.user.client, c.user.id, porters, notify);

    const mine = (await loadMyJobs(c.user.client, c.user.id)).find((j) => j.orderId === porters)!;
    expect(mine).toMatchObject({ status: "assigned", statusLabel: "Da iniziare", tab: "da-fare", porters: { persons: 2 } });

    const job = (await loadMyJob(c.user.client, c.user.id, porters))!;
    expect(job.portersPlace).toMatchObject({ address: expect.stringContaining("Indipendenza"), lat: 44.499 });
    expect(job.pickupContact).toEqual({ name: "Mario Rossi", phone: "+393331234567" });
    expect(job.addresses).toEqual([]);
    expect(job.vehicle).toBeNull();
    expect(job.release.allowed).toBe(true);

    await run(service.rpc("admin_advance_order", { p_order_id: porters, p_admin_id: admin.id, p_to_status: "picked_up" }));
    expect((await loadMyJob(c.user.client, c.user.id, porters))).toMatchObject({ statusLabel: "Lavoro iniziato", tab: "in-corso" });
  });

  it("Rinuncia: back to the list; the team gets the release e-mail with the work window", async () => {
    const porters = await paidPorters();
    const c = await portersCarrier();
    await acceptPorterJob(c.user.client, c.user.id, porters, notify);
    const errors = vi.spyOn(console, "error");
    expect(await releaseJob(c.user.client, c.user.id, porters, notify)).toEqual({ ok: true, message: JOB_MSG.released });
    expect(errors).not.toHaveBeenCalled();
    const number = (await check(service.from("orders").select("order_number").eq("id", porters).single())).order_number as string;
    const mails = await check(service.from("email_outbox").select("to_address, order_id").eq("template_code", "carrier_released_job").ilike("subject", `%${number}%`));
    expect(mails).toEqual([{ to_address: ADMIN_EMAIL, order_id: porters }]);
  });
});

describe("admin: Assegna facchini, statuses, settings", () => {
  it("candidates and assignment without a vehicle; then Lavoro iniziato → Lavoro concluso (reason required)", async () => {
    const porters = await paidPorters({ persons: 3 });
    const [small, ok] = await Promise.all([portersCarrier(2), portersCarrier(3)]);
    const candidates = await loadPorterCandidates(adminDeps(), porters);
    expect(candidates.map((c) => c.carrier_id)).toContain(ok.user.id);
    expect(candidates.map((c) => c.carrier_id)).not.toContain(small.user.id);

    expect(await assignPortersJob(adminDeps(), { orderId: porters, carrierId: small.user.id })).toEqual({ ok: false, error: DISPATCH_MSG.teamNotSuitable });
    expect(await assignPortersJob(adminDeps(), { orderId: porters, carrierId: "x" })).toEqual({ ok: false, error: DISPATCH_MSG.chooseTeam });
    expect(await assignPortersJob(adminDeps(), { orderId: porters, carrierId: ok.user.id })).toEqual({ ok: true, message: DISPATCH_MSG.portersAssigned });

    expect(await advanceOrder(adminDeps(), { orderId: porters, to: "in_transit" })).toEqual({ ok: false, error: DISPATCH_MSG.notNextStatus });
    expect(await advanceOrder(adminDeps(), { orderId: porters, to: "picked_up" })).toEqual({ ok: true, message: "Stato aggiornato: Lavoro iniziato." });
    expect(await unassignJob(adminDeps(), { orderId: porters, reason: "altro" })).toEqual({ ok: false, error: DISPATCH_MSG.workStarted });
    expect(await advanceOrder(adminDeps(), { orderId: porters, to: "delivered" })).toEqual({ ok: false, error: DISPATCH_MSG.noteRequired });
    const done = await advanceOrder(adminDeps(), { orderId: porters, to: "delivered", note: "Confermato al telefono" });
    expect(done).toEqual({ ok: true, message: `Stato aggiornato: Lavoro concluso. ${DISPATCH_MSG.deliveredWithoutPod}` });
    expect((await check(service.from("email_outbox").select("subject").eq("template_code", "order_delivered").eq("order_id", porters))).map((m) => m.subject))
      .toEqual([expect.stringMatching(/^Lavoro concluso/)]);
  });

  it("settings: validation, saved, warning when a job in progress needs more persons", async () => {
    const porters = await paidPorters({ persons: 3 });
    const c = await portersCarrier(3);
    await acceptPorterJob(c.user.client, c.user.id, porters, notify);

    expect(await setCarrierPorters(adminDeps(), { id: c.user.id, offers: "on", team: "5" })).toMatchObject({ ok: false });
    const lowered = await setCarrierPorters(adminDeps(), { id: c.user.id, offers: "on", team: "2" });
    expect(lowered).toMatchObject({ ok: true, message: expect.stringContaining("1 lavoro di facchinaggio in corso") });
    expect(await check(service.from("carriers").select("offers_porters, porters_team_size").eq("profile_id", c.user.id).single())).toEqual({ offers_porters: true, porters_team_size: 2 });
    const off = await setCarrierPorters(adminDeps(), { id: c.user.id });
    expect(off).toMatchObject({ ok: true });
    expect(await check(service.from("carriers").select("offers_porters, porters_team_size").eq("profile_id", c.user.id).single())).toEqual({ offers_porters: false, porters_team_size: null });
    // the job stays the carrier's (D116, D167)
    expect((await check(service.from("orders").select("carrier_id").eq("id", porters).single())).carrier_id).toBe(c.user.id);
  });
});
