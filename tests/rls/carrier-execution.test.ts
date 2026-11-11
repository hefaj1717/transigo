import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, createUser, deleteCreatedUsers, localSql, service, type TestUser } from "./helpers";
import {
  accept, activeCarrier, check, paidOrder, release, run, setupJobContext, teardownJobContext, type DbError, type OrderOpts,
} from "./job-fixtures";

// Carrier job execution (migration 20261111100000_carrier_job_execution.sql, plan docs/plany/realizacja-kursu.md):
// steps in order (database time), photos, POD, porter working time (D69), admin undo, who can read positions.
// LOCAL database only (D64).

let admin: TestUser;
let customer: TestUser;
let otherCustomer: TestUser;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(64).fill(1), 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(2)]);
const STEPS = ["arrived_pickup", "loaded", "departed", "arrived_delivery", "unloaded"] as const;
type Carrier = Awaited<ReturnType<typeof activeCarrier>>;
type StepRow = { recorded_at: string; newly_recorded: boolean; order_status: string };

function sql(statement: string) {
  const res = localSql(statement);
  if (!res.ok) throw new Error(res.output);
  return res.output;
}

/** Moves every leg's pickup window to now (the snapshot is immutable: triggers off, LOCAL test database only). */
function pickupToday(orderId: string) {
  sql(`set session_replication_role = replica;
    update public.order_legs set pickup_window_start = now() - interval '10 minutes', pickup_window_end = now() + interval '110 minutes'
     where order_id = '${orderId}';
    update public.orders set pickup_window_start = now() - interval '10 minutes' where id = '${orderId}';`);
}

/** Paid order accepted by a fresh active carrier, pickup today. */
async function runningJob(opts: OrderOpts = {}, today = true): Promise<{ orderId: string; c: Carrier }> {
  const orderId = await paidOrder({ hoursAhead: 72, ...opts });
  const c = await activeCarrier();
  await check(accept(c.user, orderId, c.vehicleId));
  if (today) pickupToday(orderId);
  return { orderId, c };
}

const step = (u: TestUser, orderId: string, leg: number, s: string, lat?: number, lng?: number) =>
  u.client.rpc("carrier_record_step", { p_order_id: orderId, p_leg_index: leg, p_step: s, p_lat: lat ?? null, p_lng: lng ?? null })
    .single<StepRow>() as unknown as Promise<{ data: StepRow | null; error: DbError }>;

async function photo(u: TestUser, orderId: string, leg: number, kind: "pickup" | "delivery", path = `${orderId}/${randomUUID()}.jpg`) {
  const up = await u.client.storage.from("order-photos").upload(path, JPEG, { contentType: "image/jpeg" });
  const reg = await u.client.rpc("register_order_photo", { p_order_id: orderId, p_leg_index: leg, p_kind: kind, p_storage_path: path })
    .single<{ photo_id: string; newly_registered: boolean }>();
  return { path, upload: up.error, data: reg.data, error: reg.error as DbError };
}

async function signature(u: TestUser, orderId: string) {
  const path = `${orderId}/${randomUUID()}.png`;
  const up = await u.client.storage.from("pod-signatures").upload(path, PNG, { contentType: "image/png" });
  if (up.error) throw up.error;
  return path;
}

const complete = (u: TestUser, orderId: string, name: string | null, path: string | null, lat?: number, lng?: number) =>
  u.client.rpc("complete_delivery", { p_order_id: orderId, p_recipient_name: name, p_signature_path: path, p_lat: lat ?? null, p_lng: lng ?? null })
    .single<{ delivered_at: string; newly_delivered: boolean }>();

/** All five steps of one leg, with the required photos. */
async function doLeg(u: TestUser, orderId: string, leg: number) {
  for (const s of STEPS) {
    if (s === "loaded") expect((await photo(u, orderId, leg, "pickup")).error).toBeNull();
    if (s === "unloaded") expect((await photo(u, orderId, leg, "delivery")).error).toBeNull();
    const r = await step(u, orderId, leg, s);
    expect(r.error, `${leg}:${s}`).toBeNull();
  }
}

const order = (id: string) =>
  check(service.from("orders").select("status, picked_up_at, in_transit_at, delivered_at, delivered_without_pod").eq("id", id).single());
const historyRows = (id: string) =>
  check(service.from("order_status_history").select("from_status, to_status, source, changed_by, note, lat, lng").eq("order_id", id).order("id"));
const revert = (orderId: string, reason: string | null, adminId = admin.id) =>
  service.rpc("admin_revert_last_step", { p_order_id: orderId, p_admin_id: adminId, p_reason: reason })
    .single<{ leg_index: number; step: string; order_status: string }>();

beforeAll(async () => {
  ({ admin, customer } = await setupJobContext());
  otherCustomer = await createUser({});
  await run(service.from("customers").insert({ profile_id: otherCustomer.id, customer_type: "private" }));
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

describe("one leg: steps, statuses, POD, porter time", () => {
  it("full run with database times; statuses only on leg 0 loaded / departed / POD", async () => {
    const { orderId, c } = await runningJob();
    const me = c.user;

    expect((await photo(me, orderId, 0, "pickup")).error).toBeNull();
    const seen: Record<string, string> = {};
    for (const s of STEPS) {
      if (s === "unloaded") await photo(me, orderId, 0, "delivery");
      const r = await step(me, orderId, 0, s);
      expect(r.error).toBeNull();
      expect(r.data?.newly_recorded).toBe(true);
      seen[s] = r.data!.order_status;
    }
    expect(seen).toEqual({ arrived_pickup: "assigned", loaded: "picked_up", departed: "in_transit", arrived_delivery: "in_transit", unloaded: "in_transit" });

    // the recorded time is the database's, not the phone's
    const rows = await check(service.from("order_leg_steps").select("step, created_at, created_by").eq("order_id", orderId).order("id"));
    expect(rows.map((r) => r.step)).toEqual([...STEPS]);
    expect(rows.every((r) => r.created_by === me.id)).toBe(true);
    expect(Math.abs(Date.parse(rows[0].created_at) - Date.now())).toBeLessThan(60_000);

    const sig = await signature(me, orderId);
    const done = await complete(me, orderId, "  Lucia Bianchi ", sig);
    expect(done.error).toBeNull();
    expect(done.data?.newly_delivered).toBe(true);

    const o = await order(orderId);
    expect(o).toMatchObject({ status: "delivered", delivered_without_pod: false });
    expect(o.picked_up_at && o.in_transit_at && o.delivered_at).toBeTruthy();
    expect((await historyRows(orderId)).slice(-3).map((h) => `${h.from_status}→${h.to_status}:${h.source}`)).toEqual([
      "assigned→picked_up:carrier_app", "picked_up→in_transit:carrier_app", "in_transit→delivered:carrier_app",
    ]);
    const proof = await check(service.from("delivery_proofs").select("recipient_name, signature_path, created_by").eq("order_id", orderId).single());
    expect(proof).toEqual({ recipient_name: "Lucia Bianchi", signature_path: sig, created_by: me.id });
    const legs = await check(service.from("order_legs").select("porters_worked_minutes").eq("order_id", orderId));
    expect(legs[0].porters_worked_minutes).toBe(0); // all within seconds → 0 full minutes

    // sent again (double click / lost response): same result, no error, nothing added
    const again = await complete(me, orderId, "Altro nome", await signature(me, orderId).catch(() => sig));
    expect(again.error).toBeNull();
    expect(again.data).toEqual({ delivered_at: done.data!.delivered_at, newly_delivered: false });
    expect((await historyRows(orderId)).filter((h) => h.to_status === "delivered")).toHaveLength(1);
  });

  it("double click / retry of a step: no duplicate, no error, the first time is kept", async () => {
    const { orderId, c } = await runningJob();
    const first = await step(c.user, orderId, 0, "arrived_pickup");
    const [a, b] = await Promise.all([step(c.user, orderId, 0, "arrived_pickup"), step(c.user, orderId, 0, "arrived_pickup")]);
    for (const r of [a, b]) {
      expect(r.error).toBeNull();
      expect(r.data).toEqual({ ...first.data, newly_recorded: false });
    }
    // parallel first calls of the next step: exactly one row
    await photo(c.user, orderId, 0, "pickup");
    const par = await Promise.all([1, 2, 3].map(() => step(c.user, orderId, 0, "loaded")));
    expect(par.every((r) => r.error === null)).toBe(true);
    expect(par.filter((r) => r.data?.newly_recorded)).toHaveLength(1);
    expect(await check(service.from("order_leg_steps").select("id").eq("order_id", orderId))).toHaveLength(2);
    expect((await historyRows(orderId)).filter((h) => h.to_status === "picked_up")).toHaveLength(1);
    // an earlier step sent again is also just "already recorded"
    expect((await step(c.user, orderId, 0, "arrived_pickup")).data?.newly_recorded).toBe(false);
  });

  it("only in order, no skipping (checked in the database)", async () => {
    const { orderId, c } = await runningJob();
    const u = c.user;
    expect((await step(u, orderId, 0, "loaded")).error).toMatchObject({ code: "55000", details: "wrong_step:0:arrived_pickup" });
    expect((await step(u, orderId, 0, "unloaded")).error).toMatchObject({ code: "55000", details: "wrong_step:0:arrived_pickup" });
    await run(step(u, orderId, 0, "arrived_pickup"));
    expect((await step(u, orderId, 0, "departed")).error).toMatchObject({ code: "55000", details: "wrong_step:0:loaded" });
    expect((await step(u, orderId, 1, "arrived_pickup")).error).toMatchObject({ code: "22023", details: "leg" }); // no leg 1
    expect((await step(u, orderId, 0, "bogus")).error).not.toBeNull();
    expect((await complete(u, orderId, "Lucia", `${orderId}/${randomUUID()}.png`)).error).toMatchObject({ code: "55000", details: "not_in_progress" });
    expect((await order(orderId)).status).toBe("assigned");
  });

  it("loaded / unloaded need an own photo of that leg; photos only while the step is open", async () => {
    const { orderId, c } = await runningJob();
    const u = c.user;
    await run(step(u, orderId, 0, "arrived_pickup"));
    expect((await step(u, orderId, 0, "loaded")).error).toMatchObject({ code: "55000", details: "photo_required" });
    const delivery = await photo(u, orderId, 0, "delivery"); // the wrong kind does not count
    expect(delivery.error).toBeNull();
    expect((await step(u, orderId, 0, "loaded")).error).toMatchObject({ code: "55000", details: "photo_required" });

    const p = await photo(u, orderId, 0, "pickup");
    // registering the same path again ("Riprova" after a lost response): same row, no error
    const again = await u.client.rpc("register_order_photo", { p_order_id: orderId, p_leg_index: 0, p_kind: "pickup", p_storage_path: p.path }).single<{ photo_id: string; newly_registered: boolean }>();
    expect(again.data).toEqual({ photo_id: p.data!.photo_id, newly_registered: false });
    // uploading the same file again → Storage says it exists; the photo is still registered once
    expect((await u.client.storage.from("order-photos").upload(p.path, JPEG, { contentType: "image/jpeg" })).error).not.toBeNull();

    // remove while open → step needs a photo again
    expect((await u.client.rpc("delete_order_photo", { p_photo_id: p.data!.photo_id })).data).toBe(p.path);
    expect((await u.client.rpc("delete_order_photo", { p_photo_id: p.data!.photo_id })).data).toBeNull(); // twice: no error
    expect((await step(u, orderId, 0, "loaded")).error).toMatchObject({ details: "photo_required" });
    const keep = await photo(u, orderId, 0, "pickup");
    await run(step(u, orderId, 0, "loaded"));
    // step closed: no more pickup photos for leg 0, no deleting
    expect((await photo(u, orderId, 0, "pickup")).error).toMatchObject({ code: "55000", details: "step_closed" });
    expect((await u.client.rpc("delete_order_photo", { p_photo_id: keep.data!.photo_id })).error).toMatchObject({ details: "step_closed" });
    // the unloaded step still accepts its (delivery) photos
    expect((await photo(u, orderId, 0, "delivery")).error).toBeNull();
  });

  it("photo registration checks the file: exists, own, JPEG, right folder; max 10 per leg and kind", async () => {
    const { orderId, c } = await runningJob();
    const u = c.user;
    const reg = (path: string, kind = "pickup") =>
      u.client.rpc("register_order_photo", { p_order_id: orderId, p_leg_index: 0, p_kind: kind, p_storage_path: path });
    expect((await reg(`${orderId}/${randomUUID()}.jpg`)).error).toMatchObject({ code: "22023", details: "file" }); // not uploaded
    expect((await reg(`${randomUUID()}/${randomUUID()}.jpg`)).error).toMatchObject({ code: "22023", details: "path" });
    expect((await reg(`${orderId}/../x.jpg`)).error).toMatchObject({ code: "22023", details: "path" });
    // wrong type refused by the bucket
    expect((await u.client.storage.from("order-photos").upload(`${orderId}/${randomUUID()}.jpg`, PNG, { contentType: "image/png" })).error).not.toBeNull();
    // a file uploaded by the service role (not by this carrier) is not accepted
    const foreign = `${orderId}/${randomUUID()}.jpg`;
    await service.storage.from("order-photos").upload(foreign, JPEG, { contentType: "image/jpeg" });
    expect((await reg(foreign)).error).toMatchObject({ code: "22023", details: "file" });

    for (let i = 0; i < 10; i++) expect((await photo(u, orderId, 0, "pickup")).error).toBeNull();
    expect((await photo(u, orderId, 0, "pickup")).error).toMatchObject({ code: "55000", details: "too_many_photos" });
  });

  it("arrived_pickup not before the pickup day (Europe/Rome); the admin may start the job early", async () => {
    const { orderId, c } = await runningJob({}, false); // pickup in 3 days
    expect((await step(c.user, orderId, 0, "arrived_pickup")).error).toMatchObject({ code: "55000", details: "too_early" });
    await run(service.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: admin.id, p_to_status: "picked_up" }));
    const r = await step(c.user, orderId, 0, "arrived_pickup");
    expect(r.error).toBeNull();
    await photo(c.user, orderId, 0, "pickup");
    expect((await step(c.user, orderId, 0, "loaded")).data?.order_status).toBe("picked_up"); // never backwards, no new row
    expect((await historyRows(orderId)).filter((h) => h.to_status === "picked_up")).toHaveLength(1);
  });

  it("POD: recipient name required; the signature must be an own PNG in the order's folder", async () => {
    const { orderId, c } = await runningJob();
    const u = c.user;
    await doLeg(u, orderId, 0);
    const sig = await signature(u, orderId);
    for (const name of [null, "", "   ", "x".repeat(201)]) {
      expect((await complete(u, orderId, name, sig)).error).toMatchObject({ code: "22023", details: "recipient_name" });
    }
    expect((await complete(u, orderId, "Lucia", `${orderId}/${randomUUID()}.png`)).error).toMatchObject({ code: "22023", details: "signature" });
    expect((await complete(u, orderId, "Lucia", `${randomUUID()}/${randomUUID()}.png`)).error).toMatchObject({ code: "22023", details: "signature" });
    expect((await u.client.storage.from("pod-signatures").upload(`${orderId}/${randomUUID()}.png`, JPEG, { contentType: "image/jpeg" })).error).not.toBeNull();
    expect((await order(orderId)).status).toBe("in_transit");
    expect((await complete(u, orderId, "Lucia", sig)).error).toBeNull();
  });

  it("no steps after delivery, also after the admin's Consegnato without POD", async () => {
    const { orderId, c } = await runningJob();
    await run(step(c.user, orderId, 0, "arrived_pickup"));
    for (const to of ["picked_up", "in_transit", "delivered"]) {
      await run(service.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: admin.id, p_to_status: to, p_note: to === "delivered" ? "Test" : null }));
    }
    expect((await photo(c.user, orderId, 0, "pickup")).upload).not.toBeNull(); // Storage: not running any more
    expect((await step(c.user, orderId, 0, "loaded")).error).toMatchObject({ code: "55000", details: "not_in_progress" });
    expect((await order(orderId)).delivered_without_pod).toBe(true);
  });
});

describe("two legs (warehouse, model A)", () => {
  it("in_transit while in the warehouse; leg 2 from its own pickup day; porter time per leg", async () => {
    const orderId = await paidOrder({ hoursAhead: 72, storage: true });
    const c = await activeCarrier();
    await check(accept(c.user, orderId, c.vehicleId));
    // leg 0 today, leg 1 still in 5 days
    sql(`set session_replication_role = replica;
      update public.order_legs set pickup_window_start = now() - interval '10 minutes', pickup_window_end = now() + interval '110 minutes'
       where order_id = '${orderId}' and leg_index = 0;`);
    await doLeg(c.user, orderId, 0);
    expect((await order(orderId)).status).toBe("in_transit");
    expect((await complete(c.user, orderId, "Magazzino", await signature(c.user, orderId))).error).toMatchObject({ code: "55000", details: "steps_missing" });
    expect((await step(c.user, orderId, 1, "arrived_pickup")).error).toMatchObject({ code: "55000", details: "too_early" });

    pickupToday(orderId);
    await doLeg(c.user, orderId, 1);
    expect((await order(orderId)).status).toBe("in_transit");
    expect((await step(c.user, orderId, 1, "unloaded")).data?.newly_recorded).toBe(false);
    expect((await step(c.user, orderId, 0, "arrived_pickup")).data?.newly_recorded).toBe(false);

    // set the step times (LOCAL SQL, triggers off) to check the rounding per leg; after the assignment, as in real life
    sql(`set session_replication_role = replica;
      update public.order_leg_steps s set created_at = (select o.assigned_at from public.orders o where o.id = s.order_id) + v.off
        from (values (0, 'arrived_pickup'::public.order_leg_step, interval '0'), (0, 'loaded', interval '30 minutes 59 seconds'),
                     (0, 'departed', interval '40 minutes'), (0, 'arrived_delivery', interval '2 hours'), (0, 'unloaded', interval '2 hours 29 minutes 2 seconds'),
                     (1, 'arrived_pickup', interval '3 hours'), (1, 'loaded', interval '3 hours 59 seconds'),
                     (1, 'departed', interval '3 hours 5 minutes'), (1, 'arrived_delivery', interval '4 hours'), (1, 'unloaded', interval '4 hours'))
             as v(leg, step, off)
       where s.order_id = '${orderId}' and s.leg_index = v.leg and s.step = v.step and s.reverted_at is null;`);
    // leg 0: 30:59 + 29:02 = 60:01 → 60 min; leg 1: 0:59 + 0 → 0 min (rounded down)
    const calc = await check(customer.client.rpc("order_porters_worked_minutes", { p_order_id: orderId }));
    expect(calc).toEqual([{ leg_index: 0, worked_minutes: 60, complete: true }, { leg_index: 1, worked_minutes: 0, complete: true }]);
    expect(await check(c.user.client.rpc("order_porters_worked_minutes", { p_order_id: orderId }))).toEqual(calc);
    // someone else's order: not even its legs
    expect(await check(otherCustomer.client.rpc("order_porters_worked_minutes", { p_order_id: orderId }))).toEqual([]);
    expect(await check(anon.rpc("order_porters_worked_minutes", { p_order_id: orderId })).catch(() => [])).toEqual([]);

    expect((await complete(c.user, orderId, "Lucia Bianchi", await signature(c.user, orderId))).error).toBeNull();
    const legs = await check(service.from("order_legs").select("leg_index, porters_worked_minutes").eq("order_id", orderId).order("leg_index"));
    expect(legs).toEqual([{ leg_index: 0, porters_worked_minutes: 60 }, { leg_index: 1, porters_worked_minutes: 0 }]);
  });
});

describe("who may record and read", () => {
  it("another carrier cannot record a step, register or delete a photo, upload a file or deliver someone else's job", async () => {
    const { orderId, c } = await runningJob();
    const other = await activeCarrier();
    await run(step(c.user, orderId, 0, "arrived_pickup"));
    const own = await photo(c.user, orderId, 0, "pickup");

    expect((await step(other.user, orderId, 0, "arrived_pickup")).error).toMatchObject({ code: "55000", details: "not_assigned" });
    expect((await step(other.user, orderId, 0, "loaded")).error).toMatchObject({ code: "55000", details: "not_assigned" });
    const theirs = await photo(other.user, orderId, 0, "pickup");
    expect(theirs.upload).not.toBeNull(); // Storage refuses the folder
    expect(theirs.error).toMatchObject({ code: "55000", details: "not_assigned" });
    expect((await other.user.client.rpc("delete_order_photo", { p_photo_id: own.data!.photo_id })).data).toBeNull();
    expect((await complete(other.user, orderId, "X", own.path)).error).toMatchObject({ details: "not_assigned" });
    expect((await other.user.client.storage.from("order-photos").download(own.path)).error).not.toBeNull();
    expect(await check(service.from("order_photos").select("id").eq("order_id", orderId))).toHaveLength(1);
  });

  it("the customer, an admin session and anon cannot record anything", async () => {
    const { orderId, c } = await runningJob();
    for (const client of [customer.client, admin.client, anon]) {
      expect((await client.rpc("carrier_record_step", { p_order_id: orderId, p_leg_index: 0, p_step: "arrived_pickup" })).error).not.toBeNull();
      expect((await client.rpc("register_order_photo", { p_order_id: orderId, p_leg_index: 0, p_kind: "pickup", p_storage_path: `${orderId}/${randomUUID()}.jpg` })).error).not.toBeNull();
      expect((await client.rpc("complete_delivery", { p_order_id: orderId, p_recipient_name: "X", p_signature_path: `${orderId}/${randomUUID()}.png` })).error).not.toBeNull();
      expect((await client.storage.from("order-photos").upload(`${orderId}/${randomUUID()}.jpg`, JPEG, { contentType: "image/jpeg" })).error).not.toBeNull();
      expect((await client.storage.from("pod-signatures").upload(`${orderId}/${randomUUID()}.png`, PNG, { contentType: "image/png" })).error).not.toBeNull();
    }
    expect((await customer.client.rpc("carrier_record_step", { p_order_id: orderId, p_leg_index: 0, p_step: "arrived_pickup" })).error).toMatchObject({ code: "42501" });
    // no direct writes for anyone, not even the assigned carrier or the service role
    const row = { order_id: orderId, leg_index: 0, step: "arrived_pickup", created_by: c.user.id };
    for (const client of [customer.client, c.user.client, admin.client, service]) {
      await client.from("order_leg_steps").insert(row);
      await client.from("order_photos").insert({ order_id: orderId, leg_index: 0, kind: "pickup", storage_path: `${orderId}/${randomUUID()}.jpg`, size_bytes: 10, uploaded_by: c.user.id });
      await client.from("delivery_proofs").insert({ order_id: orderId, recipient_name: "X", signature_path: `${orderId}/${randomUUID()}.png`, created_by: c.user.id });
    }
    expect(await check(service.from("order_leg_steps").select("id").eq("order_id", orderId))).toHaveLength(0);
    expect(await check(service.from("order_photos").select("id").eq("order_id", orderId))).toHaveLength(0);
    expect(await check(service.from("delivery_proofs").select("order_id").eq("order_id", orderId))).toHaveLength(0);
    expect((await order(orderId)).status).toBe("assigned");
  });

  it("positions and user ids: only admins (through functions), never the carrier or the customer", async () => {
    const { orderId, c } = await runningJob();
    await run(step(c.user, orderId, 0, "arrived_pickup", 45.46, 9.19));
    await photo(c.user, orderId, 0, "pickup");
    await run(step(c.user, orderId, 0, "loaded", 45.47, 9.2));
    await run(step(c.user, orderId, 0, "departed", 999, 9.2)); // invalid position: ignored, step recorded
    await run(step(c.user, orderId, 0, "arrived_delivery"));
    await photo(c.user, orderId, 0, "delivery");
    await run(step(c.user, orderId, 0, "unloaded"));
    await run(complete(c.user, orderId, "Lucia", await signature(c.user, orderId), 45.07, 7.68));

    for (const u of [c.user, customer, admin]) {
      for (const col of ["lat", "lng", "created_by", "reverted_by", "*"]) {
        expect((await u.client.from("order_leg_steps").select(col).eq("order_id", orderId)).error, `${col}`).toMatchObject({ code: "42501" });
      }
      for (const col of ["lat", "lng", "created_by", "*"]) {
        expect((await u.client.from("delivery_proofs").select(col).eq("order_id", orderId)).error).toMatchObject({ code: "42501" });
      }
      expect((await u.client.from("order_photos").select("uploaded_by").eq("order_id", orderId)).error).toMatchObject({ code: "42501" });
      expect((await u.client.from("order_status_history").select("lat").eq("order_id", orderId)).error).toMatchObject({ code: "42501" });
    }
    for (const u of [c.user, customer]) {
      expect((await u.client.rpc("admin_order_execution", { p_order_id: orderId })).error).toMatchObject({ code: "42501" });
      expect((await u.client.rpc("admin_delivery_proof", { p_order_id: orderId })).error).toMatchObject({ code: "42501" });
    }
    expect((await anon.rpc("admin_order_execution", { p_order_id: orderId })).error).not.toBeNull();

    // the parties read the safe columns
    const visible = "id, order_id, leg_index, step, created_at, reverted_at";
    expect(await check(customer.client.from("order_leg_steps").select(visible).eq("order_id", orderId))).toHaveLength(5);
    expect(await check(c.user.client.from("order_leg_steps").select(visible).eq("order_id", orderId))).toHaveLength(5);
    expect(await check(otherCustomer.client.from("order_leg_steps").select(visible).eq("order_id", orderId))).toHaveLength(0);

    // the admin sees where and who
    const exec = await check(admin.client.rpc("admin_order_execution", { p_order_id: orderId })) as { step: string; lat: number | null; lng: number | null; created_by: string }[];
    expect(exec.map((e) => [e.step, e.lat, e.lng])).toEqual([
      ["arrived_pickup", 45.46, 9.19], ["loaded", 45.47, 9.2], ["departed", null, null], ["arrived_delivery", null, null], ["unloaded", null, null],
    ]);
    expect(exec.every((e) => e.created_by === c.user.id)).toBe(true);
    expect(await check(admin.client.rpc("admin_delivery_proof", { p_order_id: orderId }))).toEqual([
      expect.objectContaining({ recipient_name: "Lucia", lat: 45.07, lng: 7.68, created_by: c.user.id }),
    ]);
    const h = await historyRows(orderId);
    expect(h.find((r) => r.to_status === "picked_up")).toMatchObject({ lat: 45.47, lng: 9.2 });
    expect(h.find((r) => r.to_status === "in_transit")).toMatchObject({ lat: null, lng: null });
  });

  it("the customer reads POD and photos of its own order (also the files), another customer nothing", async () => {
    const { orderId, c } = await runningJob();
    await doLeg(c.user, orderId, 0);
    const sig = await signature(c.user, orderId);
    // before the POD exists, the customer cannot open the signature file
    expect((await customer.client.storage.from("pod-signatures").download(sig)).error).not.toBeNull();
    await run(complete(c.user, orderId, "Lucia Bianchi", sig));

    const photos = await check(customer.client.from("order_photos").select("id, leg_index, kind, storage_path").eq("order_id", orderId));
    expect(photos.map((p) => p.kind).sort()).toEqual(["delivery", "pickup"]);
    expect((await customer.client.storage.from("order-photos").download(photos[0].storage_path)).error).toBeNull();
    expect((await customer.client.storage.from("pod-signatures").download(sig)).error).toBeNull();
    expect(await check(customer.client.from("delivery_proofs").select("recipient_name, signature_path, signed_at").eq("order_id", orderId))).toEqual([
      expect.objectContaining({ recipient_name: "Lucia Bianchi", signature_path: sig }),
    ]);
    expect(await check(c.user.client.from("delivery_proofs").select("recipient_name").eq("order_id", orderId))).toHaveLength(1);

    expect(await check(otherCustomer.client.from("order_photos").select("id").eq("order_id", orderId))).toHaveLength(0);
    expect(await check(otherCustomer.client.from("delivery_proofs").select("order_id").eq("order_id", orderId))).toHaveLength(0);
    expect((await otherCustomer.client.storage.from("order-photos").download(photos[0].storage_path)).error).not.toBeNull();
    expect((await otherCustomer.client.storage.from("pod-signatures").download(sig)).error).not.toBeNull();
    expect((await anon.storage.from("pod-signatures").download(sig)).error).not.toBeNull();
    expect((await admin.client.storage.from("pod-signatures").download(sig)).error).toBeNull();
  });

  it("after Rinuncia the new carrier starts from zero and sees no steps or photos of the previous one", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    await check(accept(a.user, orderId, a.vehicleId));
    pickupToday(orderId);
    await run(step(a.user, orderId, 0, "arrived_pickup"));
    const aPhoto = await photo(a.user, orderId, 0, "pickup");
    await check(release(a.user, orderId)); // within 15 minutes of accepting

    sql(`set session_replication_role = replica; update public.orders set pickup_window_start = now() + interval '1 hour' where id = '${orderId}';`);
    await check(accept(b.user, orderId, b.vehicleId));
    pickupToday(orderId);

    expect(await check(b.user.client.from("order_leg_steps").select("id").eq("order_id", orderId))).toHaveLength(0);
    expect(await check(b.user.client.from("order_photos").select("id").eq("order_id", orderId))).toHaveLength(0);
    expect((await b.user.client.storage.from("order-photos").download(aPhoto.path)).error).not.toBeNull();
    // A's step is reverted (kept for the admin), B starts with arrived_pickup and needs its OWN photo
    const r = await step(b.user, orderId, 0, "arrived_pickup");
    expect(r.data?.newly_recorded).toBe(true);
    expect((await step(b.user, orderId, 0, "loaded")).error).toMatchObject({ details: "photo_required" });
    const all = await check(service.from("order_leg_steps").select("created_by, reverted_at").eq("order_id", orderId).order("id"));
    expect(all.map((s) => [s.created_by, s.reverted_at !== null])).toEqual([[a.user.id, true], [b.user.id, false]]);
    // A no longer reads anything
    expect(await check(a.user.client.from("order_photos").select("id").eq("order_id", orderId))).toHaveLength(0);
    expect((await step(a.user, orderId, 0, "loaded")).error).toMatchObject({ details: "not_assigned" });
  });

  it("a suspended carrier finishes its job (D116)", async () => {
    const { orderId, c } = await runningJob();
    await run(service.rpc("set_carrier_suspension", { p_carrier_id: c.user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "Controllo" }));
    await doLeg(c.user, orderId, 0);
    expect((await complete(c.user, orderId, "Lucia", await signature(c.user, orderId))).error).toBeNull();
    expect((await order(orderId)).status).toBe("delivered");
  });
});

describe("immutability and undo", () => {
  it("steps and POD cannot be changed or deleted, not even by the service role or SQL", async () => {
    const { orderId, c } = await runningJob();
    await doLeg(c.user, orderId, 0);
    await run(complete(c.user, orderId, "Lucia", await signature(c.user, orderId)));

    for (const client of [c.user.client, customer.client, admin.client, service]) {
      await client.from("order_leg_steps").update({ created_at: "2020-01-01T00:00:00Z" }).eq("order_id", orderId);
      await client.from("order_leg_steps").delete().eq("order_id", orderId);
      await client.from("delivery_proofs").update({ recipient_name: "Altro" }).eq("order_id", orderId);
      await client.from("delivery_proofs").delete().eq("order_id", orderId);
      await client.from("order_photos").delete().eq("order_id", orderId);
    }
    expect(await check(service.from("order_leg_steps").select("id").eq("order_id", orderId).is("reverted_at", null))).toHaveLength(5);
    expect(await check(service.from("order_photos").select("id").eq("order_id", orderId))).toHaveLength(2);

    for (const statement of [
      `update public.order_leg_steps set created_at = now() - interval '1 hour' where order_id = '${orderId}';`,
      `update public.order_leg_steps set reverted_at = now(), lat = 1, lng = 1 where order_id = '${orderId}';`,
      `delete from public.order_leg_steps where order_id = '${orderId}';`,
      `update public.delivery_proofs set recipient_name = 'Altro' where order_id = '${orderId}';`,
      `delete from public.delivery_proofs where order_id = '${orderId}';`,
      `update public.order_photos set leg_index = 0 where order_id = '${orderId}';`,
    ]) {
      const res = localSql(statement);
      expect(res.ok, statement).toBe(false);
      expect(res.output).toContain("42501");
    }
    expect((await check(service.from("delivery_proofs").select("recipient_name").eq("order_id", orderId).single())).recipient_name).toBe("Lucia");
  });

  it("the carrier cannot undo; only an admin, with a reason in the status history, last step first", async () => {
    const { orderId, c } = await runningJob();
    const u = c.user;
    await run(step(u, orderId, 0, "arrived_pickup"));
    await photo(u, orderId, 0, "pickup");
    await run(step(u, orderId, 0, "loaded"));
    await run(step(u, orderId, 0, "departed"));
    expect((await order(orderId)).status).toBe("in_transit");

    for (const client of [u.client, customer.client, admin.client, anon]) {
      expect((await client.rpc("admin_revert_last_step", { p_order_id: orderId, p_admin_id: admin.id, p_reason: "x" })).error).not.toBeNull();
    }
    for (const reason of [null, "", "   ", "x".repeat(1001)]) {
      expect((await revert(orderId, reason)).error).toMatchObject({ code: "22023", details: "reason" });
    }
    const blocked = await createUser({});
    await run(service.from("profiles").update({ role: "admin" }).eq("id", blocked.id));
    await run(service.from("profiles").update({ is_blocked: true }).eq("id", blocked.id));
    expect((await revert(orderId, "Errore", blocked.id)).error).toMatchObject({ code: "42501" });
    expect((await revert(orderId, "Errore", u.id)).error).toMatchObject({ code: "42501" });

    // departed → back to picked_up
    expect((await revert(orderId, "Partenza segnata per errore")).data).toEqual({ leg_index: 0, step: "departed", order_status: "picked_up" });
    let o = await order(orderId);
    expect(o).toMatchObject({ status: "picked_up", in_transit_at: null });
    expect(o.picked_up_at).toBeTruthy();
    // loaded → back to assigned
    expect((await revert(orderId, "Carico non completo")).data).toEqual({ leg_index: 0, step: "loaded", order_status: "assigned" });
    o = await order(orderId);
    expect(o).toMatchObject({ status: "assigned", picked_up_at: null });
    // arrived_pickup → no status change, still a history row with the reason
    expect((await revert(orderId, "Arrivo segnato per errore")).data).toEqual({ leg_index: 0, step: "arrived_pickup", order_status: "assigned" });
    expect((await revert(orderId, "Niente")).error).toMatchObject({ code: "55000", details: "no_step" });

    // history: only real status changes, without a note; the reasons are internal (order_admin_notes)
    const h = (await historyRows(orderId)).filter((r) => r.source === "admin_panel");
    expect(h.map((r) => [r.from_status, r.to_status, r.note, r.changed_by])).toEqual([
      ["in_transit", "picked_up", null, admin.id],
      ["picked_up", "assigned", null, admin.id],
    ]);
    expect(await check(service.from("order_admin_notes").select("kind, leg_index, body, created_by").eq("order_id", orderId).order("id"))).toEqual([
      { kind: "step_reverted", leg_index: 0, body: "Partenza segnata per errore", created_by: admin.id },
      { kind: "step_reverted", leg_index: 0, body: "Carico non completo", created_by: admin.id },
      { kind: "step_reverted", leg_index: 0, body: "Arrivo segnato per errore", created_by: admin.id },
    ]);
    // audit: no free text
    const audit = await check(service.from("audit_log").select("action, data").eq("entity_id", orderId).eq("action", "order.step_reverted").order("id"));
    expect(audit.map((a) => a.data)).toEqual([
      { leg_index: 0, step: "departed", from: "in_transit", to: "picked_up" },
      { leg_index: 0, step: "loaded", from: "picked_up", to: "assigned" },
      { leg_index: 0, step: "arrived_pickup", from: "assigned", to: "assigned" },
    ]);

    // the carrier redoes the steps; its photo stays and the step can be closed again
    expect((await step(u, orderId, 0, "arrived_pickup")).data?.newly_recorded).toBe(true);
    expect((await step(u, orderId, 0, "loaded")).data).toMatchObject({ newly_recorded: true, order_status: "picked_up" });
    expect(await check(service.from("order_leg_steps").select("id").eq("order_id", orderId))).toHaveLength(5); // 3 reverted + 2 live

    // nothing to undo after delivery
    await run(step(u, orderId, 0, "departed"));
    await run(step(u, orderId, 0, "arrived_delivery"));
    await photo(u, orderId, 0, "delivery");
    await run(step(u, orderId, 0, "unloaded"));
    await run(complete(u, orderId, "Lucia", await signature(u, orderId)));
    expect((await revert(orderId, "Troppo tardi")).error).toMatchObject({ code: "55000", details: "not_in_progress" });
  });
});

describe("internal admin reasons (owner 2026-11-11)", () => {
  it("the customer and the carrier never read a reason; the admin does", async () => {
    const { orderId, c } = await runningJob({ storage: true });
    await run(step(c.user, orderId, 0, "arrived_pickup"));
    await check(revert(orderId, "Motivo interno: arrivo"));
    await check(service.rpc("admin_allow_early_start", { p_order_id: orderId, p_leg_index: 1, p_admin_id: admin.id, p_reason: "Motivo interno: anticipo" }));
    for (const to of ["picked_up", "in_transit", "delivered"]) {
      await run(service.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: admin.id, p_to_status: to, p_note: to === "delivered" ? "Motivo interno: consegna" : null }));
    }

    for (const u of [customer, c.user, otherCustomer]) {
      expect(await check(u.client.from("order_admin_notes").select("id").eq("order_id", orderId))).toHaveLength(0);
      expect((await u.client.from("order_admin_notes").select("body")).data ?? []).toHaveLength(0);
    }
    expect((await anon.from("order_admin_notes").select("body")).data ?? []).toHaveLength(0);
    const seen = [
      ...(await check(customer.client.from("order_status_history").select("note").eq("order_id", orderId))),
      ...(await check(c.user.client.from("order_status_history").select("note").eq("order_id", orderId))),
    ];
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.note === null)).toBe(true);
    const all = await check(service.from("order_status_history").select("note").eq("order_id", orderId));
    expect(all.every((r) => r.note === null)).toBe(true); // nowhere in the history, not only hidden
    // no free text in the audit log either (D65)
    const audit = JSON.stringify(await check(service.from("audit_log").select("data").eq("entity_id", orderId)));
    expect(audit).not.toContain("Motivo interno");

    const notes = await check(admin.client.from("order_admin_notes").select("kind, leg_index, body").eq("order_id", orderId).order("id"));
    expect(notes).toEqual([
      { kind: "step_reverted", leg_index: 0, body: "Motivo interno: arrivo" },
      { kind: "early_start", leg_index: 1, body: "Motivo interno: anticipo" },
      { kind: "delivered_without_pod", leg_index: null, body: "Motivo interno: consegna" },
    ]);
    // append-only, no direct writes
    for (const client of [admin.client, service, customer.client]) {
      await client.from("order_admin_notes").insert({ order_id: orderId, kind: "status_changed", body: "x", created_by: admin.id });
      await client.from("order_admin_notes").update({ body: "y" }).eq("order_id", orderId);
      await client.from("order_admin_notes").delete().eq("order_id", orderId);
    }
    expect(await check(service.from("order_admin_notes").select("body").eq("order_id", orderId))).toHaveLength(3);
    expect(localSql(`update public.order_admin_notes set body = 'y' where order_id = '${orderId}';`).output).toContain("42501");
  });
});

describe("no Rinuncia once the load is on board (owner 2026-11-11)", () => {
  it("before loading the usual rules apply; after loaded on leg 0 → 'loaded', also in transit", async () => {
    const { orderId, c } = await runningJob();
    await run(step(c.user, orderId, 0, "arrived_pickup"));
    await photo(c.user, orderId, 0, "pickup");
    await run(step(c.user, orderId, 0, "loaded"));
    expect((await release(c.user, orderId)).error).toMatchObject({ code: "55000", details: "loaded" });
    await run(step(c.user, orderId, 0, "departed"));
    expect((await release(c.user, orderId)).error).toMatchObject({ code: "55000", details: "loaded" });
    expect((await order(orderId)).status).toBe("in_transit");
    // the server code behind "Rinuncia": the Italian message and the "Contatta Transigo" box, no e-mail
    const { releaseJob } = await import("@/lib/carriers/jobs-server");
    let mails = 0;
    const deps = { serviceDb: () => { mails++; return service; }, adminEmail: "ops@example.com", appUrl: "https://transigo.example" };
    expect(await releaseJob(c.user.client, c.user.id, orderId, deps)).toEqual({ ok: false, error: "Il carico è già a bordo. Contatta Transigo.", tooLate: true });
    expect(mails).toBe(0);
    // another carrier still gets not_assigned (no information about the load)
    const other = await activeCarrier();
    expect((await release(other.user, orderId)).error).toMatchObject({ code: "55000", details: "not_assigned" });
  });

  it("only arrived_pickup (nothing loaded): Rinuncia within 15 minutes still works", async () => {
    const { orderId, c } = await runningJob();
    await run(step(c.user, orderId, 0, "arrived_pickup"));
    expect((await release(c.user, orderId)).error).toBeNull();
    expect((await order(orderId)).status).toBe("paid");
  });

  it("the admin can take a loaded job away (Rimuovi padroncino): steps reverted, the carrier loses access", async () => {
    const { orderId, c } = await runningJob();
    await run(step(c.user, orderId, 0, "arrived_pickup"));
    await photo(c.user, orderId, 0, "pickup");
    await run(step(c.user, orderId, 0, "loaded"));
    await run(service.rpc("admin_unassign_job", { p_order_id: orderId, p_admin_id: admin.id, p_reason_code: "problema_veicolo" }));
    expect(await order(orderId)).toMatchObject({ status: "paid", picked_up_at: null });
    expect(await check(service.from("order_leg_steps").select("id").eq("order_id", orderId).is("reverted_at", null))).toHaveLength(0);
    expect(await check(service.from("order_photos").select("id").eq("order_id", orderId))).toHaveLength(1); // kept for the admin
    expect(await check(c.user.client.from("order_photos").select("id").eq("order_id", orderId))).toHaveLength(0);
    expect((await step(c.user, orderId, 0, "departed")).error).toMatchObject({ details: "not_assigned" });
    const audit = await check(service.from("audit_log").select("data").eq("entity_id", orderId).eq("action", "order.unassigned"));
    expect(audit[0].data).toMatchObject({ from: "picked_up", goods_loaded: true });
  });
});

describe("admin_allow_early_start (owner 2026-11-11)", () => {
  it("leg 2 of a warehouse order may start before its pickup day; reason required; once", async () => {
    const orderId = await paidOrder({ hoursAhead: 72, storage: true });
    const c = await activeCarrier();
    await check(accept(c.user, orderId, c.vehicleId));
    const allow = (leg: number, reason: string | null, adminId = admin.id) =>
      service.rpc("admin_allow_early_start", { p_order_id: orderId, p_leg_index: leg, p_admin_id: adminId, p_reason: reason }).single<{ allowed_at: string; newly_allowed: boolean }>();

    for (const client of [c.user.client, customer.client, admin.client, anon]) {
      expect((await client.rpc("admin_allow_early_start", { p_order_id: orderId, p_leg_index: 1, p_admin_id: admin.id, p_reason: "x" })).error).not.toBeNull();
    }
    for (const reason of [null, "", "  ", "x".repeat(1001)]) expect((await allow(1, reason)).error).toMatchObject({ code: "22023", details: "reason" });
    expect((await allow(2, "x")).error).toMatchObject({ code: "22023", details: "leg" });
    expect((await allow(1, "x", c.user.id)).error).toMatchObject({ code: "42501" });

    // leg 0 too (3 days ahead): allowed early by the admin, without changing the status
    expect((await step(c.user, orderId, 0, "arrived_pickup")).error).toMatchObject({ details: "too_early" });
    expect((await allow(0, "Il cliente è pronto oggi")).data?.newly_allowed).toBe(true);
    expect((await order(orderId)).status).toBe("assigned");
    expect((await allow(0, "di nuovo")).data?.newly_allowed).toBe(false);
    await doLeg(c.user, orderId, 0);

    expect((await step(c.user, orderId, 1, "arrived_pickup")).error).toMatchObject({ code: "55000", details: "too_early" });
    const first = await allow(1, "Il cliente ritira prima dal magazzino");
    expect(first.data?.newly_allowed).toBe(true);
    expect((await allow(1, "di nuovo")).data).toEqual({ allowed_at: first.data!.allowed_at, newly_allowed: false });
    await doLeg(c.user, orderId, 1);
    expect((await allow(1, "tardi")).data?.newly_allowed).toBe(false); // already set: no-op
    expect((await complete(c.user, orderId, "Lucia", await signature(c.user, orderId))).error).toBeNull();

    // the snapshot is still immutable apart from the two execution columns; set once
    expect(localSql(`update public.order_legs set early_start_allowed_at = now(), distance_m = 1 where order_id = '${orderId}' and leg_index = 1;`).output).toContain("42501");
    const notes = await check(service.from("order_admin_notes").select("kind, leg_index").eq("order_id", orderId).order("id"));
    expect(notes).toEqual([{ kind: "early_start", leg_index: 0 }, { kind: "early_start", leg_index: 1 }]);
    expect((await historyRows(orderId)).filter((h) => h.source === "admin_panel")).toHaveLength(0); // no status change, no history row
  });

  it("not after the leg started, not on a finished job", async () => {
    const { orderId, c } = await runningJob();
    await run(step(c.user, orderId, 0, "arrived_pickup"));
    const allow = () => service.rpc("admin_allow_early_start", { p_order_id: orderId, p_leg_index: 0, p_admin_id: admin.id, p_reason: "x" });
    expect((await allow()).error).toMatchObject({ code: "55000", details: "already_started" });
    const done = await runningJob();
    await doLeg(done.c.user, done.orderId, 0);
    await run(complete(done.c.user, done.orderId, "Lucia", await signature(done.c.user, done.orderId)));
    expect((await service.rpc("admin_allow_early_start", { p_order_id: done.orderId, p_leg_index: 0, p_admin_id: admin.id, p_reason: "x" })).error)
      .toMatchObject({ code: "55000", details: "not_in_progress" });
  });
});

