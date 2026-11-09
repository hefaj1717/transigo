import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";

// Stage 4 / part 1, step 4 — admin actions outside the review of a submission (D113–D115):
// review_carrier_document, approve_carrier_vehicle, set_carrier_suspension.

const FUTURE = "2099-12-31";
const PAST = "2020-01-01";

const plate = () => `TG${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const vat = () => `IT${Math.floor(Math.random() * 1e11).toString().padStart(11, "0")}`;
const doc = (carrierId: string, docType: string, extra: Record<string, unknown> = {}) => ({
  carrier_id: carrierId, doc_type: docType, storage_path: `${carrierId}/${randomUUID()}.pdf`,
  file_name: "documento.pdf", mime_type: "application/pdf", size_bytes: 2048, ...extra,
});
const company = () => ({
  company_name: "Trasporti Test Srl", vat_number: vat(), fiscal_code: "RSSMRA80A01H501U",
  hq_street: "Via Roma 1", hq_city: "Milano", hq_postal_code: "20100", hq_province: "MI", sdi_code: "M5UXCR1",
});
const check = async <T,>(p: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> => {
  const { data, error } = await p;
  if (error) throw error;
  if (data == null) throw new Error("expected data, got null");
  return data;
};
const run = async (p: PromiseLike<{ error: unknown }>) => {
  const { error } = await p;
  if (error) throw error;
};

let vanId: string;
let admin: TestUser;
let blockedAdmin: TestUser;
let cliente: TestUser;

async function insertDoc(c: TestUser, docType: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await check(c.client.from("carrier_documents").insert(doc(c.id, docType, extra)).select("id").single())).id;
}

async function addVehicle(c: TestUser, withDocs = true): Promise<string> {
  const v = await check(c.client.from("carrier_vehicles").insert({ carrier_id: c.id, vehicle_type_id: vanId, plate: plate(), payload_kg: 1000 }).select("id").single());
  if (withDocs) {
    await insertDoc(c, "vehicle_registration", { vehicle_id: v.id, expires_at: FUTURE });
    await insertDoc(c, "insurance_rca", { vehicle_id: v.id, expires_at: FUTURE });
  }
  return v.id;
}

/** A carrier submitted and approved by the admin: status active, everything approved. */
async function activeCarrier(): Promise<{ user: TestUser; vehicleId: string }> {
  const user = await createUser({ role: "padroncino" });
  await run(service.from("carriers").insert({ profile_id: user.id, ...company() }));
  await insertDoc(user, "transport_license");
  await insertDoc(user, "driving_license", { expires_at: FUTURE });
  const vehicleId = await addVehicle(user);
  await run(user.client.rpc("submit_carrier_for_review"));
  await run(service.rpc("decide_carrier_review", { p_carrier_id: user.id, p_admin_id: admin.id, p_approve: true, p_reason: null }));
  return { user, vehicleId };
}

const reviewDoc = (id: string, adminId: string, approve: boolean, reason?: string | null) =>
  service.rpc("review_carrier_document", { p_document_id: id, p_admin_id: adminId, p_approve: approve, p_reason: reason ?? null });
const approveVehicle = (id: string, adminId: string) =>
  service.rpc("approve_carrier_vehicle", { p_vehicle_id: id, p_admin_id: adminId });
const suspension = (carrierId: string, adminId: string, suspend: boolean, reason?: string | null) =>
  service.rpc("set_carrier_suspension", { p_carrier_id: carrierId, p_admin_id: adminId, p_suspend: suspend, p_reason: reason ?? null });
const docRow = (id: string) =>
  check(service.from("carrier_documents").select("review_status, reviewed_by, reviewed_at, rejection_reason").eq("id", id).single());
const vehicleRow = (id: string) =>
  check(service.from("carrier_vehicles").select("approved_at, first_approved_at").eq("id", id).single());
const carrierRow = (id: string) =>
  check(service.from("carriers").select("status, status_reason").eq("profile_id", id).single());
const lastAudit = async (entityId: string) =>
  (await check(service.from("audit_log").select("action, actor_id, actor_email, entity_type, data").eq("entity_id", entityId).order("id", { ascending: false }).limit(1)))[0];

beforeAll(async () => {
  vanId = (await check(service.from("vehicle_types").select("id").eq("code", "van_medium").single())).id;
  [admin, blockedAdmin, cliente] = await Promise.all([createUser({}), createUser({}), createUser({})]);
  await run(service.from("profiles").update({ role: "admin" }).in("id", [admin.id, blockedAdmin.id]));
  await run(service.from("profiles").update({ is_blocked: true }).eq("id", blockedAdmin.id));
  await run(service.from("customers").insert({ profile_id: cliente.id, customer_type: "private" }));
});

afterAll(async () => {
  await deleteCreatedUsers();
});

describe("who may call the admin functions", () => {
  it("anon, cliente, padroncino and admin through the API cannot; only the server (service role)", async () => {
    const { user, vehicleId } = await activeCarrier();
    const docId = await insertDoc(user, "goods_insurance", { expires_at: FUTURE });
    for (const client of [anon, cliente.client, user.client, admin.client]) {
      expect((await client.rpc("review_carrier_document", { p_document_id: docId, p_admin_id: admin.id, p_approve: true })).error).not.toBeNull();
      expect((await client.rpc("approve_carrier_vehicle", { p_vehicle_id: vehicleId, p_admin_id: admin.id })).error).not.toBeNull();
      expect((await client.rpc("set_carrier_suspension", { p_carrier_id: user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "x" })).error).not.toBeNull();
    }
    expect((await docRow(docId)).review_status).toBe("pending");
    expect((await carrierRow(user.id)).status).toBe("active");
  });

  it("p_admin_id must be an active admin (blocked admin, cliente, the carrier itself → 42501)", async () => {
    const { user, vehicleId } = await activeCarrier();
    const docId = await insertDoc(user, "goods_insurance", { expires_at: FUTURE });
    for (const who of [blockedAdmin.id, cliente.id, user.id, randomUUID()]) {
      expect((await reviewDoc(docId, who, true)).error?.code).toBe("42501");
      expect((await approveVehicle(vehicleId, who)).error?.code).toBe("42501");
      expect((await suspension(user.id, who, true, "Motivo")).error?.code).toBe("42501");
    }
  });
});

describe("review_carrier_document (D113)", () => {
  let carrier: { user: TestUser; vehicleId: string };
  beforeAll(async () => {
    carrier = await activeCarrier();
  });

  it("approves a pending document of an active carrier, once", async () => {
    const id = await insertDoc(carrier.user, "goods_insurance", { expires_at: FUTURE });
    expect((await reviewDoc(id, admin.id, true)).data).toBe("approved");
    expect(await docRow(id)).toMatchObject({ review_status: "approved", reviewed_by: admin.id, rejection_reason: null });
    expect((await reviewDoc(id, admin.id, false, "Ripensamento")).error?.code).toBe("55000");
    expect(await lastAudit(id)).toEqual({
      action: "carrier.document_approved", actor_id: admin.id, actor_email: admin.email, entity_type: "carrier_document",
      data: { carrier_id: carrier.user.id, vehicle_id: null, doc_type: "goods_insurance" },
    });
  });

  it("rejection requires a reason (≤ 1000); the reason stays on the document, not in the log", async () => {
    const id = await insertDoc(carrier.user, "insurance_rca", { vehicle_id: carrier.vehicleId, expires_at: FUTURE });
    expect((await reviewDoc(id, admin.id, false)).error?.code).toBe("22023");
    expect((await reviewDoc(id, admin.id, false, "   ")).error?.code).toBe("22023");
    expect((await reviewDoc(id, admin.id, false, "x".repeat(1001))).error?.code).toBe("22023");
    expect((await reviewDoc(id, admin.id, false, "  Documento illeggibile  ")).data).toBe("rejected");
    expect(await docRow(id)).toMatchObject({ review_status: "rejected", rejection_reason: "Documento illeggibile" });
    const entry = await lastAudit(id);
    expect(entry.action).toBe("carrier.document_rejected");
    expect(JSON.stringify(entry.data)).not.toContain("illeggibile");
  });

  it("a rejected required document counts as missing again (D99)", async () => {
    // The approved RCA from the submission is still there, so rejecting a newer one does not make it missing...
    expect(await carrier.user.client.rpc("carrier_onboarding_missing", { p_carrier_id: carrier.user.id })).toMatchObject({ data: [] });
    // ...but a carrier whose only patente gets rejected misses it.
    const other = await activeCarrier();
    const patente = (await check(service.from("carrier_documents").select("id").eq("carrier_id", other.user.id).eq("doc_type", "driving_license").single())).id;
    await run(service.from("carrier_documents").update({ review_status: "pending" }).eq("id", patente));
    await run(reviewDoc(patente, admin.id, false, "Scaduta"));
    expect((await service.rpc("carrier_onboarding_missing", { p_carrier_id: other.user.id })).data).toEqual(["document:driving_license"]);
  });

  it("works for a suspended carrier; not for one in onboarding or in review (decide_carrier_review handles those)", async () => {
    const suspended = await activeCarrier();
    await run(suspension(suspended.user.id, admin.id, true, "RCA scaduta"));
    const id = await insertDoc(suspended.user, "goods_insurance", { expires_at: FUTURE });
    expect((await reviewDoc(id, admin.id, true)).data).toBe("approved");

    const incomplete = await createUser({ role: "padroncino" });
    await run(service.from("carriers").insert({ profile_id: incomplete.id, ...company() }));
    const draftDoc = await insertDoc(incomplete, "transport_license");
    expect((await reviewDoc(draftDoc, admin.id, true)).error?.code).toBe("55000");
    expect((await docRow(draftDoc)).review_status).toBe("pending");
  });

  it("unknown document → 22023", async () => {
    expect((await reviewDoc(randomUUID(), admin.id, true)).error?.code).toBe("22023");
  });
});

describe("approve_carrier_vehicle (D114)", () => {
  let carrier: { user: TestUser; vehicleId: string };
  beforeAll(async () => {
    carrier = await activeCarrier();
  });

  it("new vehicle: approves it with its pending valid documents, sets first_approved_at, once", async () => {
    const v = await addVehicle(carrier.user);
    const expired = await insertDoc(carrier.user, "insurance_rca", { vehicle_id: v, expires_at: PAST });
    const at = (await approveVehicle(v, admin.id)).data;
    expect(at).not.toBeNull();
    const row = await vehicleRow(v);
    expect(row.approved_at).not.toBeNull();
    expect(row.first_approved_at).toBe(row.approved_at);

    const docs = await check(service.from("carrier_documents").select("id, review_status").eq("vehicle_id", v));
    expect(docs.filter((d) => d.id !== expired).every((d) => d.review_status === "approved")).toBe(true);
    expect(docs.find((d) => d.id === expired)?.review_status).toBe("pending"); // expired: not approved with the vehicle

    const entry = await lastAudit(v);
    expect(entry).toMatchObject({ action: "carrier.vehicle_approved", entity_type: "carrier_vehicle", actor_email: admin.email });
    expect(entry.data).toMatchObject({ carrier_id: carrier.user.id, reapproval: false });
    expect((entry.data as { document_ids: string[] }).document_ids).toHaveLength(2);

    expect((await approveVehicle(v, admin.id)).error?.code).toBe("55000");
  });

  it("re-verification after a payload change keeps first_approved_at", async () => {
    await run(carrier.user.client.from("carrier_vehicles").update({ payload_kg: 1500 }).eq("id", carrier.vehicleId));
    const before = await vehicleRow(carrier.vehicleId);
    expect(before.approved_at).toBeNull();
    await run(approveVehicle(carrier.vehicleId, admin.id));
    const after = await vehicleRow(carrier.vehicleId);
    expect(after.approved_at).not.toBeNull();
    expect(after.first_approved_at).toBe(before.first_approved_at);
    expect((await lastAudit(carrier.vehicleId)).data).toMatchObject({ reapproval: true, document_ids: [] });
  });

  it("refuses a vehicle with missing or expired required documents (23514)", async () => {
    const v = await addVehicle(carrier.user, false);
    await insertDoc(carrier.user, "vehicle_registration", { vehicle_id: v, expires_at: FUTURE });
    await insertDoc(carrier.user, "insurance_rca", { vehicle_id: v, expires_at: PAST });
    const { error } = await approveVehicle(v, admin.id);
    expect(error?.code).toBe("23514");
    expect((await vehicleRow(v)).approved_at).toBeNull();
    // nothing approved on the failed attempt
    const docs = await check(service.from("carrier_documents").select("review_status").eq("vehicle_id", v));
    expect(docs.every((d) => d.review_status === "pending")).toBe(true);
  });

  it("refuses a vehicle with a rejected required document", async () => {
    const v = await addVehicle(carrier.user, false);
    await insertDoc(carrier.user, "vehicle_registration", { vehicle_id: v, expires_at: FUTURE });
    const rca = await insertDoc(carrier.user, "insurance_rca", { vehicle_id: v, expires_at: FUTURE });
    await run(reviewDoc(rca, admin.id, false, "Targa non corrispondente"));
    expect((await approveVehicle(v, admin.id)).error?.code).toBe("23514");
  });

  it("refuses an inactive vehicle and a carrier that is not active or suspended (55000)", async () => {
    const v = await addVehicle(carrier.user);
    await run(carrier.user.client.from("carrier_vehicles").update({ is_active: false }).eq("id", v));
    expect((await approveVehicle(v, admin.id)).error?.code).toBe("55000");

    const incomplete = await createUser({ role: "padroncino" });
    await run(service.from("carriers").insert({ profile_id: incomplete.id, ...company() }));
    const draft = await addVehicle(incomplete);
    expect((await approveVehicle(draft, admin.id)).error?.code).toBe("55000");
  });

  it("works for a suspended carrier", async () => {
    const suspended = await activeCarrier();
    const v = await addVehicle(suspended.user);
    await run(suspension(suspended.user.id, admin.id, true, "Controllo"));
    expect((await approveVehicle(v, admin.id)).error).toBeNull();
  });
});

describe("set_carrier_suspension (D115)", () => {
  it("Sospendi: active only, reason required; the carrier sees the reason; audit without the reason", async () => {
    const { user } = await activeCarrier();
    expect((await suspension(user.id, admin.id, true)).error?.code).toBe("22023");
    expect((await suspension(user.id, admin.id, true, "x".repeat(1001))).error?.code).toBe("22023");
    expect((await suspension(user.id, admin.id, true, " RCA scaduta ")).data).toBe("suspended");
    expect(await check(user.client.from("carriers").select("status, status_reason").eq("profile_id", user.id).single()))
      .toEqual({ status: "suspended", status_reason: "RCA scaduta" });
    expect(await lastAudit(user.id)).toMatchObject({ action: "carrier.suspended", entity_type: "carrier", data: {} });
    expect((await suspension(user.id, admin.id, true, "Ancora")).error?.code).toBe("55000");
  });

  it("Riattiva: suspended only; clears the reason", async () => {
    const { user } = await activeCarrier();
    expect((await suspension(user.id, admin.id, false)).error?.code).toBe("55000"); // active
    await run(suspension(user.id, admin.id, true, "Controllo"));
    expect((await suspension(user.id, admin.id, false)).data).toBe("active");
    expect(await carrierRow(user.id)).toEqual({ status: "active", status_reason: null });
    expect((await lastAudit(user.id)).action).toBe("carrier.reactivated");
  });

  it("Riattiva is refused while a document uploaded during the suspension waits for review", async () => {
    const { user, vehicleId } = await activeCarrier();
    await run(suspension(user.id, admin.id, true, "RCA scaduta"));
    const rca = await insertDoc(user, "insurance_rca", { vehicle_id: vehicleId, expires_at: FUTURE });
    const { error } = await suspension(user.id, admin.id, false);
    expect(error?.code).toBe("55000");
    expect((error as { details?: string }).details).toBe("pending_documents");
    expect((await carrierRow(user.id)).status).toBe("suspended");
    await run(reviewDoc(rca, admin.id, true));
    expect((await suspension(user.id, admin.id, false)).data).toBe("active");
  });

  it("a pending document of a deactivated vehicle does not block Riattiva", async () => {
    const { user } = await activeCarrier();
    const old = await addVehicle(user);
    await run(user.client.from("carrier_vehicles").update({ is_active: false }).eq("id", old));
    await run(suspension(user.id, admin.id, true, "Controllo"));
    expect((await suspension(user.id, admin.id, false)).data).toBe("active");
  });

  it("Riattiva is refused when the account is incomplete (23514, missing items in detail)", async () => {
    const { user } = await activeCarrier();
    const patente = (await check(service.from("carrier_documents").select("id").eq("carrier_id", user.id).eq("doc_type", "driving_license").single())).id;
    await run(service.from("carrier_documents").update({ expires_at: PAST }).eq("id", patente));
    await run(suspension(user.id, admin.id, true, "Patente scaduta"));
    const { error } = await suspension(user.id, admin.id, false);
    expect(error?.code).toBe("23514");
    expect((error as { details?: string }).details).toBe("document:driving_license");
  });

  it("not for carriers in onboarding, in review or rejected", async () => {
    const incomplete = await createUser({ role: "padroncino" });
    await run(service.from("carriers").insert({ profile_id: incomplete.id, ...company() }));
    expect((await suspension(incomplete.id, admin.id, true, "Motivo")).error?.code).toBe("55000");
    expect((await suspension(incomplete.id, admin.id, false)).error?.code).toBe("55000");
    expect((await suspension(randomUUID(), admin.id, true, "Motivo")).error?.code).toBe("22023");
  });

  it("the carrier still cannot change status or reason itself", async () => {
    const { user } = await activeCarrier();
    await run(suspension(user.id, admin.id, true, "Controllo"));
    await user.client.from("carriers").update({ status: "active", status_reason: null }).eq("profile_id", user.id);
    expect(await carrierRow(user.id)).toEqual({ status: "suspended", status_reason: "Controllo" });
  });
});
