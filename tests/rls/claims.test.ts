import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, localSql, service, type TestUser } from "./helpers";
import { JPEG, PNG } from "./execution-fixtures";
import { accept, activeCarrier, check, paidOrder, run, setupJobContext, teardownJobContext, type DbError } from "./job-fixtures";

// Customer claims (D138; migration 20261111150000_claims.sql). On the real database: who may open a claim and when
// (own delivered order, 14 days, one open at a time — also under concurrency), photos (own open claim, JPEG in
// Storage uploaded by the customer, max 5), who reads what (customer own, admin all, carrier and others nothing —
// tables and files), no direct writes for anyone, closing only by an active admin with an audit row without text.

let customer: TestUser;
let otherCustomer: TestUser;
let admin: TestUser;
let carrier: { user: TestUser; vehicleId: string };

type OpenRow = { claim_id: string; newly_opened: boolean };
const open = (c: TestUser, orderId: string, description = "La lavatrice è arrivata con un'ammaccatura sul lato.", category = "damaged_goods") =>
  c.client.rpc("open_claim", { p_order_id: orderId, p_category: category, p_description: description }).single<OpenRow>();
const regPhoto = (c: TestUser, claimId: string, path: string) =>
  c.client.rpc("register_claim_photo", { p_claim_id: claimId, p_storage_path: path }).single<{ photo_id: string; newly_registered: boolean }>();
const close = (claimId: string, adminId = admin.id, note: string | null = "Rimborso parziale concordato con il cliente.") =>
  service.rpc("admin_close_claim", { p_claim_id: claimId, p_admin_id: adminId, p_note: note });

/** A paid order taken by the carrier and delivered through the admin (delivered_at = now). */
async function deliveredOrder(): Promise<string> {
  const orderId = await paidOrder({ hoursAhead: 72 });
  await check(accept(carrier.user, orderId, carrier.vehicleId));
  for (const to of ["picked_up", "in_transit", "delivered"]) {
    await check(service.rpc("admin_advance_order", { p_order_id: orderId, p_admin_id: admin.id, p_to_status: to, p_note: to === "delivered" ? "Consegna confermata (test)" : null }));
  }
  return orderId;
}

async function uploadAndRegister(c: TestUser, claimId: string) {
  const path = `${claimId}/${randomUUID()}.jpg`;
  const up = await c.client.storage.from("claim-photos").upload(path, JPEG, { contentType: "image/jpeg" });
  if (up.error) throw up.error;
  return { path, reg: await regPhoto(c, claimId, path) };
}

beforeAll(async () => {
  const ctx = await setupJobContext();
  customer = ctx.customer;
  admin = ctx.admin;
  otherCustomer = await createUser({});
  await run(service.from("customers").insert({ profile_id: otherCustomer.id, customer_type: "private" }));
  carrier = await activeCarrier("van_medium", 1200);
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined); // accounts with paid orders stay (D77); local DB is reset per run
});

describe("open_claim", () => {
  it("opens a claim on an own delivered order; again → the same claim (one open per order)", async () => {
    const orderId = await deliveredOrder();
    const first = await check(open(customer, orderId, "  La lavatrice è arrivata con un'ammaccatura sul lato.  "));
    expect(first.newly_opened).toBe(true);
    const again = await check(open(customer, orderId, "Altra descrizione, diversa dalla prima."));
    expect(again).toEqual({ claim_id: first.claim_id, newly_opened: false });
    const row = await check(service.from("claims").select("order_id, customer_id, category, description, status").eq("id", first.claim_id).single());
    expect(row).toEqual({ order_id: orderId, customer_id: customer.id, category: "damaged_goods", description: "La lavatrice è arrivata con un'ammaccatura sul lato.", status: "open" });
  });

  it("concurrent opening: exactly one claim", async () => {
    const orderId = await deliveredOrder();
    const results = await Promise.all([open(customer, orderId), open(customer, orderId), open(customer, orderId)]);
    expect(results.map((r) => r.error)).toEqual([null, null, null]);
    expect(results.filter((r) => r.data?.newly_opened)).toHaveLength(1);
    expect(new Set(results.map((r) => r.data?.claim_id)).size).toBe(1);
  });

  it("not delivered yet, another customer's order, bad input — refused", async () => {
    const paid = await paidOrder({ hoursAhead: 72 });
    expect((await open(customer, paid)).error).toMatchObject({ code: "55000", details: "not_delivered" });
    const delivered = await deliveredOrder();
    expect((await open(otherCustomer, delivered)).error).toMatchObject({ code: "22023", details: "order" });
    expect((await open(customer, delivered, "corta")).error).toMatchObject({ code: "22023", details: "description" });
    expect((await open(customer, delivered, "x".repeat(4001))).error).toMatchObject({ code: "22023", details: "description" });
    expect((await customer.client.rpc("open_claim", { p_order_id: delivered, p_category: null, p_description: "Descrizione abbastanza lunga" })).error)
      .toMatchObject({ code: "22023", details: "category" });
    expect(await check(service.from("claims").select("id").eq("order_id", delivered))).toEqual([]);
  });

  it("more than 14 days after the delivery → too_late; exactly within → allowed", async () => {
    const late = await deliveredOrder();
    expect(localSql(`update public.orders set delivered_at = now() - interval '14 days 1 minute' where id = '${late}';`).ok).toBe(true);
    expect((await open(customer, late)).error).toMatchObject({ code: "55000", details: "too_late" });
    const inTime = await deliveredOrder();
    expect(localSql(`update public.orders set delivered_at = now() - interval '13 days 23 hours' where id = '${inTime}';`).ok).toBe(true);
    expect((await open(customer, inTime)).error).toBeNull();
  });

  it("only customers: anon, carrier, admin sessions and a blocked customer are refused", async () => {
    const orderId = await deliveredOrder();
    expect((await anon.rpc("open_claim", { p_order_id: orderId, p_category: "other", p_description: "Descrizione abbastanza lunga" })).error).toMatchObject({ code: "42501" });
    for (const u of [carrier.user, admin]) expect((await open(u, orderId)).error).toMatchObject({ code: "42501" });
    await run(service.from("profiles").update({ is_blocked: true }).eq("id", customer.id));
    try {
      expect((await open(customer, orderId)).error).toMatchObject({ code: "42501" });
    } finally {
      await run(service.from("profiles").update({ is_blocked: false }).eq("id", customer.id));
    }
  });

  it("after closing, a new claim on the same order can be opened", async () => {
    const orderId = await deliveredOrder();
    const first = await check(open(customer, orderId));
    expect(await check(close(first.claim_id))).toBe(true);
    const second = await check(open(customer, orderId, "Manca ancora uno scatolone, il numero 4."));
    expect(second.newly_opened).toBe(true);
    expect(second.claim_id).not.toBe(first.claim_id);
  });
});

describe("photos", () => {
  it("own open claim: upload + register, the same path again is not a new photo; max 5", async () => {
    const orderId = await deliveredOrder();
    const { claim_id } = await check(open(customer, orderId));
    const firstPhoto = await uploadAndRegister(customer, claim_id);
    expect(firstPhoto.reg.data?.newly_registered).toBe(true);
    expect((await check(regPhoto(customer, claim_id, firstPhoto.path))).newly_registered).toBe(false);
    for (let i = 0; i < 4; i++) expect((await uploadAndRegister(customer, claim_id)).reg.error).toBeNull();
    const sixth = await uploadAndRegister(customer, claim_id);
    expect(sixth.reg.error).toMatchObject({ code: "55000", details: "too_many_photos" });
    expect(await check(service.from("claim_photos").select("id").eq("claim_id", claim_id))).toHaveLength(5);
  });

  it("Storage refuses: another customer's claim, a closed claim, a non-JPEG, a bad name", async () => {
    const orderId = await deliveredOrder();
    const { claim_id } = await check(open(customer, orderId));
    expect((await otherCustomer.client.storage.from("claim-photos").upload(`${claim_id}/${randomUUID()}.jpg`, JPEG, { contentType: "image/jpeg" })).error).not.toBeNull();
    expect((await carrier.user.client.storage.from("claim-photos").upload(`${claim_id}/${randomUUID()}.jpg`, JPEG, { contentType: "image/jpeg" })).error).not.toBeNull();
    expect((await customer.client.storage.from("claim-photos").upload(`${claim_id}/${randomUUID()}.png`, PNG, { contentType: "image/png" })).error).not.toBeNull();
    expect((await customer.client.storage.from("claim-photos").upload(`${claim_id}/foto.jpg`, JPEG, { contentType: "image/jpeg" })).error).not.toBeNull();
    await check(close(claim_id));
    expect((await customer.client.storage.from("claim-photos").upload(`${claim_id}/${randomUUID()}.jpg`, JPEG, { contentType: "image/jpeg" })).error).not.toBeNull();
  });

  it("register refuses: a file not uploaded by the customer, a missing file, another claim's path, a closed claim", async () => {
    const orderId = await deliveredOrder();
    const { claim_id } = await check(open(customer, orderId));
    const foreign = `${claim_id}/${randomUUID()}.jpg`;
    await service.storage.from("claim-photos").upload(foreign, JPEG, { contentType: "image/jpeg" });
    expect((await regPhoto(customer, claim_id, foreign)).error).toMatchObject({ code: "22023", details: "file" });
    expect((await regPhoto(customer, claim_id, `${claim_id}/${randomUUID()}.jpg`)).error).toMatchObject({ code: "22023", details: "file" });
    expect((await regPhoto(customer, claim_id, `${randomUUID()}/${randomUUID()}.jpg`)).error).toMatchObject({ code: "22023", details: "path" });
    expect((await regPhoto(otherCustomer, claim_id, foreign)).error).toMatchObject({ code: "22023", details: "claim" });

    const ok = await uploadAndRegister(customer, claim_id);
    expect(ok.reg.error).toBeNull();
    await check(close(claim_id));
    const path = `${claim_id}/${randomUUID()}.jpg`;
    expect((await regPhoto(customer, claim_id, path)).error).toMatchObject({ code: "55000", details: "closed" });
  });
});

describe("who reads what", () => {
  it("customer: own claims and photos (rows and files); other customer and carrier: nothing; admin: everything", async () => {
    const orderId = await deliveredOrder();
    const { claim_id } = await check(open(customer, orderId));
    const { path } = await uploadAndRegister(customer, claim_id);

    expect(await check(customer.client.from("claims").select("id").eq("id", claim_id))).toHaveLength(1);
    expect(await check(customer.client.from("claim_photos").select("storage_path").eq("claim_id", claim_id))).toEqual([{ storage_path: path }]);
    expect((await customer.client.storage.from("claim-photos").createSignedUrl(path, 60)).error).toBeNull();

    for (const u of [otherCustomer, carrier.user]) {
      expect(await check(u.client.from("claims").select("id").eq("id", claim_id))).toEqual([]);
      expect(await check(u.client.from("claim_photos").select("id").eq("claim_id", claim_id))).toEqual([]);
      expect((await u.client.storage.from("claim-photos").createSignedUrl(path, 60)).error).not.toBeNull();
    }
    expect((await anon.from("claims").select("id").eq("id", claim_id)).error).toMatchObject({ code: "42501" }); // no grant at all

    expect(await check(admin.client.from("claims").select("id").eq("id", claim_id))).toHaveLength(1);
    expect(await check(admin.client.from("claim_photos").select("id").eq("claim_id", claim_id))).toHaveLength(1);
    expect((await admin.client.storage.from("claim-photos").createSignedUrl(path, 60)).error).toBeNull();
  });

  it("nobody writes the tables directly — not even the service role", async () => {
    const orderId = await deliveredOrder();
    const { claim_id } = await check(open(customer, orderId));
    const row = { order_id: orderId, customer_id: customer.id, category: "other", description: "Inserito direttamente" };
    for (const client of [customer.client, admin.client, service]) {
      expect((await client.from("claims").insert(row)).error).not.toBeNull();
      const upd = await client.from("claims").update({ status: "closed", resolution_note: "x", closed_at: new Date().toISOString() }).eq("id", claim_id).select("id");
      expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
      expect((await client.from("claim_photos").insert({ claim_id, storage_path: `${claim_id}/${randomUUID()}.jpg`, size_bytes: 10, uploaded_by: customer.id })).error).not.toBeNull();
    }
    expect((await check(service.from("claims").select("status").eq("id", claim_id).single())).status).toBe("open");
  });
});

describe("admin_close_claim", () => {
  it("closes with the note; audit keeps only ids; a second call returns false", async () => {
    const orderId = await deliveredOrder();
    const { claim_id } = await check(open(customer, orderId));
    expect(await check(close(claim_id))).toBe(true);
    expect(await check(close(claim_id))).toBe(false);
    const row = await check(service.from("claims").select("status, closed_by, resolution_note, closed_at").eq("id", claim_id).single());
    expect(row).toMatchObject({ status: "closed", closed_by: admin.id, resolution_note: "Rimborso parziale concordato con il cliente." });
    const audit = await check(service.from("audit_log").select("action, actor_id, data").eq("entity_id", claim_id));
    expect(audit).toEqual([{ action: "claim.closed", actor_id: admin.id, data: { order_id: orderId } }]);
    expect(await check(customer.client.from("claims").select("resolution_note").eq("id", claim_id).single())).toEqual({ resolution_note: "Rimborso parziale concordato con il cliente." });
  });

  it("refused: not an admin, a blocked admin, an empty note, sessions instead of the service role", async () => {
    const orderId = await deliveredOrder();
    const { claim_id } = await check(open(customer, orderId));
    expect((await close(claim_id, customer.id)).error).toMatchObject({ code: "42501" });
    expect((await close(claim_id, admin.id, "  ")).error).toMatchObject({ code: "22023", details: "note" });
    for (const u of [customer, admin]) {
      expect((await u.client.rpc("admin_close_claim", { p_claim_id: claim_id, p_admin_id: admin.id, p_note: "x" })).error as DbError).toMatchObject({ code: "42501" });
    }
    await run(service.from("profiles").update({ is_blocked: true }).eq("id", admin.id));
    try {
      expect((await close(claim_id)).error).toMatchObject({ code: "42501" });
    } finally {
      await run(service.from("profiles").update({ is_blocked: false }).eq("id", admin.id));
    }
    expect((await check(service.from("claims").select("status").eq("id", claim_id).single())).status).toBe("open");
  });
});
