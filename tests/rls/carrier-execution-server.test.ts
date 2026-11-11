import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  completeDelivery,
  createPhotoUpload,
  createSignatureUpload,
  deletePhoto,
  loadJobExecution,
  recordStep,
  registerPhoto,
  type ExecutionDeps,
} from "@/lib/carriers/execution-server";
import { EXEC_MSG, LEG_STEPS, photoKindForStep, uploadErrorMessage, type LegStep, type PhotoKind } from "@/lib/carriers/execution";
import { ORDER_DELIVERED_TEMPLATE } from "@/lib/notifications/templates/order-customer-updates";
import { anon, deleteCreatedUsers, service, type TestUser } from "./helpers";
import { check, setupJobContext, teardownJobContext } from "./job-fixtures";
import { JPEG, order, PNG, runningJob, sql } from "./execution-fixtures";

// Job execution — server code of the Server Actions (src/lib/carriers/execution-server.ts) on the LOCAL database
// (D64): the carrier's own session, signed upload URLs, the real RPCs, Storage limits and the e-mail outbox.
// The DAL / session gate in front of it is covered by le-mie-corse/[id]/actions.test.ts.

let customer: TestUser;

/** Real deps: the service role only for the file removal and the outbox (like job-deps.ts). */
const deps: ExecutionDeps = { serviceDb: () => service, appUrl: "https://transigo.example" };

beforeAll(async () => {
  ({ customer } = await setupJobContext());
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

/** What the browser does: ticket → upload to the signed URL → register. Returns the server's answers. */
async function takePhoto(u: TestUser, orderId: string, legIndex: number, kind: PhotoKind, body: Buffer = JPEG) {
  const ticket = await createPhotoUpload(u.client, { orderId, legIndex, kind });
  if (!ticket.ok) return { ticket, upload: null, reg: null };
  const up = await u.client.storage.from("order-photos").uploadToSignedUrl(ticket.path, ticket.token!, body, { contentType: "image/jpeg" });
  const upload = uploadErrorMessage(up.error as never, "photo");
  const reg = await registerPhoto(u.client, { orderId, legIndex, kind, path: ticket.path });
  return { ticket, upload, reg };
}

async function sign(u: TestUser, orderId: string) {
  const ticket = await createSignatureUpload(u.client, { orderId });
  if (!ticket.ok) throw new Error(ticket.message);
  const up = await u.client.storage.from("pod-signatures").uploadToSignedUrl(ticket.path, ticket.token!, PNG, { contentType: "image/png" });
  expect(uploadErrorMessage(up.error as never, "signature")).toBeNull();
  return ticket.path;
}

/** Every step of one leg through the server code, with the photos each step needs. */
async function runLeg(u: TestUser, orderId: string, legIndex: number) {
  for (const step of LEG_STEPS) {
    const kind = photoKindForStep(step);
    if (kind) expect((await takePhoto(u, orderId, legIndex, kind)).reg).toMatchObject({ ok: true, newlyRegistered: true });
    expect(await recordStep(u.client, { orderId, legIndex, step }), `${legIndex}:${step}`).toMatchObject({ ok: true, newlyRecorded: true });
  }
}

const deliveredMails = async (orderId: string) =>
  check(service.from("email_outbox").select("id, status").eq("order_id", orderId).eq("template_code", ORDER_DELIVERED_TEMPLATE));

const storedFiles = async (bucket: string, orderId: string) =>
  ((await service.storage.from(bucket).list(orderId)).data ?? []).map((f) => `${orderId}/${f.name}`);

describe("full run through the server code", () => {
  it("one leg: «Sono arrivato al ritiro» → … → «Consegnato», POD and ONE order_delivered e-mail", async () => {
    const { orderId, c } = await runningJob();
    const me = c.user;
    const statuses: Record<string, string> = {};
    for (const step of LEG_STEPS) {
      const kind = photoKindForStep(step);
      if (kind) {
        const p = await takePhoto(me, orderId, 0, kind);
        expect(p.ticket).toMatchObject({ ok: true, alreadyUploaded: false });
        expect(p.upload).toBeNull();
        expect(p.reg).toMatchObject({ ok: true, message: EXEC_MSG.photoSaved, newlyRegistered: true });
      }
      const r = await recordStep(me.client, { orderId, legIndex: 0, step, lat: 45.46, lng: 9.19 });
      expect(r).toMatchObject({ ok: true, message: EXEC_MSG.stepSaved, newlyRecorded: true });
      if (r.ok) statuses[step] = r.orderStatus;
    }
    expect(statuses).toEqual({ arrived_pickup: "assigned", loaded: "picked_up", departed: "in_transit", arrived_delivery: "in_transit", unloaded: "in_transit" });

    // Double tap of a recorded step: success, nothing new.
    expect(await recordStep(me.client, { orderId, legIndex: 0, step: "unloaded" })).toMatchObject({ ok: true, newlyRecorded: false });

    const sig = await sign(me, orderId);
    expect(await completeDelivery(me.client, { orderId, recipientName: "  Lucia Bianchi ", signaturePath: sig }, deps))
      .toEqual({ ok: true, message: EXEC_MSG.delivered, newlyDelivered: true });

    expect(await order(orderId)).toMatchObject({ status: "delivered", delivered_without_pod: false });
    const proof = await check(service.from("delivery_proofs").select("recipient_name, signature_path, created_by").eq("order_id", orderId).single());
    expect(proof).toEqual({ recipient_name: "Lucia Bianchi", signature_path: sig, created_by: me.id });
    const legs = await check(service.from("order_legs").select("porters_worked_minutes").eq("order_id", orderId));
    expect(legs[0].porters_worked_minutes).toBe(0); // steps seconds apart → 0 full minutes
    expect(await deliveredMails(orderId)).toHaveLength(1);

    // The same confirmation again (double tap, "Riprova" after a lost answer): success, no second e-mail.
    expect(await completeDelivery(me.client, { orderId, recipientName: "Lucia Bianchi", signaturePath: sig }, deps))
      .toMatchObject({ ok: true, newlyDelivered: false });
    expect(await deliveredMails(orderId)).toHaveLength(1);

    // After delivery no more steps or photos.
    expect(await recordStep(me.client, { orderId, legIndex: 0, step: "arrived_pickup" })).toMatchObject({ ok: true, newlyRecorded: false });
    expect(await createPhotoUpload(me.client, { orderId, legIndex: 0, kind: "delivery" })).toEqual({ ok: false, message: EXEC_MSG.notInProgress, refresh: true });
  });

  it("order with warehouse (2 legs): «In magazzino» stays in_transit, then leg 2 and POD", async () => {
    const { orderId, c } = await runningJob({ storage: true });
    const me = c.user;
    await runLeg(me, orderId, 0);
    expect((await order(orderId)).status).toBe("in_transit");

    // POD before leg 2 is done: refused by the database.
    const early = await sign(me, orderId);
    expect(await completeDelivery(me.client, { orderId, recipientName: "Mario", signaturePath: early }, deps))
      .toEqual({ ok: false, message: EXEC_MSG.stepsMissing, refresh: true });
    expect(await deliveredMails(orderId)).toHaveLength(0);

    await runLeg(me, orderId, 1);
    expect(await completeDelivery(me.client, { orderId, recipientName: "Mario Rossi", signaturePath: await sign(me, orderId) }, deps))
      .toMatchObject({ ok: true, newlyDelivered: true });
    expect((await order(orderId)).status).toBe("delivered");
    const legs = await check(service.from("order_legs").select("leg_index, porters_worked_minutes").eq("order_id", orderId).order("leg_index"));
    expect(legs.map((l) => l.leg_index)).toEqual([0, 1]);
    expect(await deliveredMails(orderId)).toHaveLength(1);
  });

  it("a suspended carrier finishes its accepted job (D116)", async () => {
    const { orderId, c } = await runningJob();
    await check(service.from("carriers").update({ status: "suspended" }).eq("profile_id", c.user.id).select("profile_id"));
    await runLeg(c.user, orderId, 0);
    expect(await completeDelivery(c.user.client, { orderId, recipientName: "Anna", signaturePath: await sign(c.user, orderId) }, deps))
      .toMatchObject({ ok: true, newlyDelivered: true });
  });
});

describe("errors as Italian messages", () => {
  it("wrong order of steps and the step without its photo", async () => {
    const { orderId, c } = await runningJob();
    const me = c.user;
    expect(await recordStep(me.client, { orderId, legIndex: 0, step: "departed" })).toEqual({ ok: false, message: EXEC_MSG.wrongStep, refresh: true });
    expect(await recordStep(me.client, { orderId, legIndex: 1, step: "arrived_pickup" })).toEqual({ ok: false, message: EXEC_MSG.wrongStep, refresh: true });
    expect(await recordStep(me.client, { orderId, legIndex: 0, step: "arrived_pickup" })).toMatchObject({ ok: true });
    expect(await recordStep(me.client, { orderId, legIndex: 0, step: "loaded" })).toEqual({ ok: false, message: EXEC_MSG.photoRequired, refresh: false });
    expect((await order(orderId)).status).toBe("assigned");
  });

  it("before the pickup day", async () => {
    const { orderId, c } = await runningJob({}, false);
    expect(await recordStep(c.user.client, { orderId, legIndex: 0, step: "arrived_pickup" })).toEqual({ ok: false, message: EXEC_MSG.tooEarly, refresh: false });
  });

  it("photo too big: refused by the bucket (413), its registration fails, nothing is stored", async () => {
    const { orderId, c } = await runningJob();
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 1);
    const p = await takePhoto(c.user, orderId, 0, "pickup", big);
    expect(p.ticket).toMatchObject({ ok: true });
    expect(p.upload).toEqual({ message: EXEC_MSG.photoTooBig, refresh: false });
    expect(p.reg).toEqual({ ok: false, message: EXEC_MSG.photoInvalid, refresh: false });
    expect(await storedFiles("order-photos", orderId)).toEqual([]);
    expect(await check(service.from("order_photos").select("id").eq("order_id", orderId))).toEqual([]);
  });

  it("«Riprova» after an upload that arrived: same path → alreadyUploaded, registration once", async () => {
    const { orderId, c } = await runningJob();
    const me = c.user;
    const first = await takePhoto(me, orderId, 0, "pickup");
    if (!first.ticket.ok || !first.reg?.ok) throw new Error("first photo failed");
    const retry = await createPhotoUpload(me.client, { orderId, legIndex: 0, kind: "pickup", path: first.ticket.path });
    expect(retry).toEqual({ ok: true, path: first.ticket.path, token: null, signedUrl: null, alreadyUploaded: true });
    expect(await registerPhoto(me.client, { orderId, legIndex: 0, kind: "pickup", path: first.ticket.path }))
      .toMatchObject({ ok: true, photoId: first.reg.photoId, newlyRegistered: false });
  });

  it("delete: own photo while the step is open (row and file gone); after the step → stepClosed, file stays", async () => {
    const { orderId, c } = await runningJob();
    const me = c.user;
    await recordStep(me.client, { orderId, legIndex: 0, step: "arrived_pickup" });
    const a = await takePhoto(me, orderId, 0, "pickup");
    const b = await takePhoto(me, orderId, 0, "pickup");
    if (!a.reg?.ok || !b.reg?.ok || !a.ticket.ok || !b.ticket.ok) throw new Error("photos failed");

    expect(await deletePhoto(me.client, { photoId: a.reg.photoId }, deps)).toEqual({ ok: true, message: EXEC_MSG.photoRemoved });
    expect(await storedFiles("order-photos", orderId)).toEqual([b.ticket.path]);
    expect(await deletePhoto(me.client, { photoId: a.reg.photoId }, deps)).toMatchObject({ ok: true }); // double tap

    expect(await recordStep(me.client, { orderId, legIndex: 0, step: "loaded" })).toMatchObject({ ok: true });
    expect(await deletePhoto(me.client, { photoId: b.reg.photoId }, deps)).toEqual({ ok: false, message: EXEC_MSG.stepClosed, refresh: true });
    expect(await storedFiles("order-photos", orderId)).toEqual([b.ticket.path]);
    // A photo for a closed step cannot be added either.
    expect((await takePhoto(me, orderId, 0, "pickup")).reg).toEqual({ ok: false, message: EXEC_MSG.stepClosed, refresh: true });
  });

  it("someone else's order: another carrier, the customer and an anonymous client change nothing", async () => {
    const { orderId, c } = await runningJob();
    const owner = c.user;
    await recordStep(owner.client, { orderId, legIndex: 0, step: "arrived_pickup" });
    const mine = await takePhoto(owner, orderId, 0, "pickup");
    if (!mine.reg?.ok || !mine.ticket.ok) throw new Error("photo failed");

    const other = (await runningJob()).c.user;
    expect(await createPhotoUpload(other.client, { orderId, legIndex: 0, kind: "pickup" })).toEqual({ ok: false, message: EXEC_MSG.notInProgress, refresh: true });
    expect(await recordStep(other.client, { orderId, legIndex: 0, step: "loaded" })).toEqual({ ok: false, message: EXEC_MSG.notAssigned, refresh: true });
    expect(await registerPhoto(other.client, { orderId, legIndex: 0, kind: "pickup", path: mine.ticket.path }))
      .toEqual({ ok: false, message: EXEC_MSG.notAssigned, refresh: true });
    expect(await deletePhoto(other.client, { photoId: mine.reg.photoId }, deps)).toMatchObject({ ok: true }); // not its photo: nothing to delete
    expect(await completeDelivery(other.client, { orderId, recipientName: "X", signaturePath: `${orderId}/${crypto.randomUUID()}.png` }, deps))
      .toEqual({ ok: false, message: EXEC_MSG.notAssigned, refresh: true });

    expect(await recordStep(customer.client, { orderId, legIndex: 0, step: "loaded" })).toEqual({ ok: false, message: EXEC_MSG.forbidden, refresh: false });
    expect(await deletePhoto(customer.client, { photoId: mine.reg.photoId }, deps)).toEqual({ ok: false, message: EXEC_MSG.forbidden, refresh: false });
    expect(await createSignatureUpload(customer.client, { orderId })).toEqual({ ok: false, message: EXEC_MSG.notInProgress, refresh: true });
    expect(await recordStep(anon, { orderId, legIndex: 0, step: "loaded" })).toMatchObject({ ok: false });

    // Nothing changed: the owner's photo and file are there, the step was not recorded.
    expect(await storedFiles("order-photos", orderId)).toEqual([mine.ticket.path]);
    expect(await check(service.from("order_photos").select("id").eq("order_id", orderId))).toHaveLength(1);
    const steps = await check(service.from("order_leg_steps").select("step").eq("order_id", orderId).is("reverted_at", null));
    expect(steps.map((s) => s.step as LegStep)).toEqual(["arrived_pickup"]);
    expect((await order(orderId)).status).toBe("assigned");
  });
});

describe("order_delivered e-mail", () => {
  it("an e-mail failure does not undo the delivery, is logged with the order id, and repeating the confirmation sends it once", async () => {
    const { orderId, c } = await runningJob();
    const me = c.user;
    await runLeg(me, orderId, 0);
    const sig = await sign(me, orderId);

    // The e-mail step fails (a client that cannot read the order) — the delivery stays.
    const broken: ExecutionDeps = { serviceDb: () => anon, appUrl: deps.appUrl };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await completeDelivery(me.client, { orderId, recipientName: "Lucia", signaturePath: sig }, broken))
      .toMatchObject({ ok: true, newlyDelivered: true });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("order_delivered e-mail failed"), expect.objectContaining({ orderId }));
    errors.mockRestore();
    expect((await order(orderId)).status).toBe("delivered");
    expect(await deliveredMails(orderId)).toHaveLength(0);

    // Sent again: the same confirmation → the e-mail now goes out, exactly once.
    expect(await completeDelivery(me.client, { orderId, recipientName: "Lucia", signaturePath: sig }, deps)).toMatchObject({ ok: true, newlyDelivered: false });
    expect(await completeDelivery(me.client, { orderId, recipientName: "Lucia", signaturePath: sig }, deps)).toMatchObject({ ok: true, newlyDelivered: false });
    expect(await deliveredMails(orderId)).toHaveLength(1);
  });
});

describe("screen data (loadJobExecution)", () => {
  /** Records whether (and when) the service role was asked for anything. */
  function recordingDeps() {
    const calls: string[] = [];
    return { calls, deps: { serviceDb: () => (calls.push("service"), service) } };
  }

  it("the carrier's own job: steps, own photos with preview URLs, porter time — no positions, ids or amounts", async () => {
    const { orderId, c } = await runningJob();
    const me = c.user;
    await recordStep(me.client, { orderId, legIndex: 0, step: "arrived_pickup", lat: 45.46, lng: 9.19 });
    const p = await takePhoto(me, orderId, 0, "pickup");
    expect(p.reg).toMatchObject({ ok: true });

    const { calls, deps: d } = recordingDeps();
    const view = await loadJobExecution(me.client, me.id, orderId, d);
    expect(view).toMatchObject({
      orderId, status: "assigned",
      steps: [{ legIndex: 0, step: "arrived_pickup" }],
      photos: [{ legIndex: 0, kind: "pickup", url: expect.stringContaining("/storage/v1/object/sign/order-photos/") }],
      porters: [{ legIndex: 0, workedMinutes: 0, includedLabel: "1 h", overtimeHours: 0 }],
      handover: null, proof: null,
    });
    expect(calls).toEqual(["service"]); // the overtime yes/no, after the session read

    // Nothing the carrier must not get: no position, no author, no rate, no amounts.
    const json = JSON.stringify(view);
    for (const forbidden of ["lat", "lng", "created_by", "uploaded_by", "rate", "cents", "3500", "35.00", me.id]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });

  it("overtime: only the HOURS reach the browser, and only when the bought price list has an overtime rate", async () => {
    const { orderId, c } = await runningJob();
    const me = c.user;
    await recordStep(me.client, { orderId, legIndex: 0, step: "arrived_pickup" });
    await takePhoto(me, orderId, 0, "pickup");
    await recordStep(me.client, { orderId, legIndex: 0, step: "loaded" });
    // 2 h of loading (> 1 h included + 15 min grace): move arrived_pickup back (LOCAL test database only).
    sql(`set session_replication_role = replica;
      update public.order_leg_steps set created_at = created_at - interval '2 hours' where order_id = '${orderId}' and step = 'arrived_pickup';`);

    const withRate = await loadJobExecution(me.client, me.id, orderId, deps);
    expect(withRate?.porters[0]).toMatchObject({ workedMinutes: 120, overtimeHours: 1 });
    expect(JSON.stringify(withRate)).not.toMatch(/rate|cents|3500/);

    sql(`set session_replication_role = replica;
      update public.order_charges set porter_overtime_rate_cents = null where order_id = '${orderId}';`);
    const withoutRate = await loadJobExecution(me.client, me.id, orderId, deps);
    expect(withoutRate?.porters[0]).toMatchObject({ workedMinutes: 120, overtimeHours: 0 });
  });

  it("someone else's order: null, and the service role is never asked", async () => {
    const { orderId, c } = await runningJob();
    const other = (await runningJob()).c.user;
    const { calls, deps: d } = recordingDeps();
    expect(await loadJobExecution(other.client, other.id, orderId, d)).toBeNull();
    expect(await loadJobExecution(customer.client, customer.id, orderId, d)).toBeNull();
    // The user id is only a filter next to RLS: the owner's id with another session does not open the order.
    expect(await loadJobExecution(other.client, c.user.id, orderId, d)).toBeNull();
    expect(await loadJobExecution(other.client, other.id, "not-a-uuid", d)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("after delivery: the proof (name, time), without the signature path", async () => {
    const { orderId, c } = await runningJob();
    await runLeg(c.user, orderId, 0);
    await completeDelivery(c.user.client, { orderId, recipientName: "Lucia", signaturePath: await sign(c.user, orderId) }, deps);
    const view = await loadJobExecution(c.user.client, c.user.id, orderId, deps);
    expect(view?.status).toBe("delivered");
    expect(view?.proof).toEqual({ recipientName: "Lucia", signedAt: expect.any(String) });
    expect(JSON.stringify(view)).not.toContain(".png");
  });
});
