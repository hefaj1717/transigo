import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { CARRIER_DOCUMENT_TYPES } from "@/lib/carriers/document-types";
import { anon, createUser, deleteCreatedUsers, localSql, service, type TestUser } from "./helpers";

// Stage 4 / part 1 — carrier onboarding and admin review (D97–D103):
// document type configuration, type-dependent document rules, isolation between carriers,
// carrier_onboarding_missing / submit_carrier_for_review / decide_carrier_review, company data lock (D105).

const FUTURE = "2099-12-31";
const PAST = "2020-01-01";
const BUCKET = "carrier-documents";

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

/** A carrier with complete company data (no vehicles or documents yet). */
async function newCarrier(): Promise<TestUser> {
  const u = await createUser({ role: "padroncino" });
  await run(service.from("carriers").insert({ profile_id: u.id, ...company() }));
  return u;
}

/** Adds an active vehicle with its required documents (as the carrier). */
async function addVehicle(c: TestUser): Promise<string> {
  const v = await check(c.client.from("carrier_vehicles").insert({ carrier_id: c.id, vehicle_type_id: vanId, plate: plate(), payload_kg: 1000 }).select("id").single());
  await run(c.client.from("carrier_documents").insert([
    doc(c.id, "vehicle_registration", { vehicle_id: v.id, expires_at: FUTURE }),
    doc(c.id, "insurance_rca", { vehicle_id: v.id, expires_at: FUTURE }),
  ]));
  return v.id;
}

/** Complete carrier: company data, Albo, patente, one vehicle with libretto + RCA. */
async function completeCarrier(): Promise<{ user: TestUser; vehicleId: string }> {
  const user = await newCarrier();
  await run(user.client.from("carrier_documents").insert([
    doc(user.id, "transport_license"),
    doc(user.id, "driving_license", { expires_at: FUTURE }),
  ]));
  return { user, vehicleId: await addVehicle(user) };
}

const missing = async (c: TestUser, carrierId = c.id) => c.client.rpc("carrier_onboarding_missing", { p_carrier_id: carrierId });
const decide = (carrierId: string, adminId: string, approve: boolean, reason?: string) =>
  service.rpc("decide_carrier_review", { p_carrier_id: carrierId, p_admin_id: adminId, p_approve: approve, p_reason: reason ?? null });
const carrierRow = (id: string) =>
  check(service.from("carriers").select("status, status_reason, submitted_at, decided_at, decided_by, activated_at, activated_by").eq("profile_id", id).single());

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

describe("carrier_document_types (D98)", () => {
  it("the table equals the configuration in code", async () => {
    const rows = await check(service.from("carrier_document_types").select("*").order("sort_order"));
    expect(rows.map((r) => ({
      docType: r.doc_type, scope: r.scope, isRequired: r.is_required, isAccepted: r.is_accepted, expiry: r.expiry,
      labelIt: r.label_it, expiryLabelIt: r.expiry_label_it, sortOrder: r.sort_order,
    }))).toEqual([...CARRIER_DOCUMENT_TYPES].sort((a, b) => a.sortOrder - b.sortOrder));
  });

  it("is readable by signed-in users, not by anon; nobody can change it", async () => {
    const c = await newCarrier();
    expect((await c.client.from("carrier_document_types").select("doc_type")).data).toHaveLength(CARRIER_DOCUMENT_TYPES.length);
    expect((await anon.from("carrier_document_types").select("doc_type")).data ?? []).toEqual([]);
    const upd = await admin.client.from("carrier_document_types").update({ is_required: false }).eq("doc_type", "transport_license");
    expect(upd.error).not.toBeNull();
  });
});

describe("carrier_documents — rules by type (D98) and file metadata", () => {
  let c: TestUser;
  let vehicleId: string;

  beforeAll(async () => {
    c = await newCarrier();
    vehicleId = (await check(c.client.from("carrier_vehicles").insert({ carrier_id: c.id, vehicle_type_id: vanId, plate: plate(), payload_kg: 900 }).select("id").single())).id;
  });

  it("Albo: no expiry date", async () => {
    expect((await c.client.from("carrier_documents").insert(doc(c.id, "transport_license"))).error).toBeNull();
    expect((await c.client.from("carrier_documents").insert(doc(c.id, "transport_license", { expires_at: FUTURE }))).error?.code).toBe("23514");
  });

  it("patente and RC vettoriale: expiry required, company documents (no vehicle)", async () => {
    for (const t of ["driving_license", "goods_insurance"]) {
      expect((await c.client.from("carrier_documents").insert(doc(c.id, t))).error?.code).toBe("23514");
      expect((await c.client.from("carrier_documents").insert(doc(c.id, t, { expires_at: FUTURE, vehicle_id: vehicleId }))).error?.code).toBe("23514");
      expect((await c.client.from("carrier_documents").insert(doc(c.id, t, { expires_at: FUTURE }))).error).toBeNull();
    }
  });

  it("libretto and RCA: vehicle and expiry required", async () => {
    for (const t of ["vehicle_registration", "insurance_rca"]) {
      expect((await c.client.from("carrier_documents").insert(doc(c.id, t, { expires_at: FUTURE }))).error?.code).toBe("23514");
      expect((await c.client.from("carrier_documents").insert(doc(c.id, t, { vehicle_id: vehicleId }))).error?.code).toBe("23514");
      expect((await c.client.from("carrier_documents").insert(doc(c.id, t, { vehicle_id: vehicleId, expires_at: FUTURE }))).error).toBeNull();
    }
  });

  it("identity document is no longer accepted (verified by Stripe, D97)", async () => {
    expect((await c.client.from("carrier_documents").insert(doc(c.id, "identity_document"))).error?.code).toBe("23514");
  });

  it("the rules bind the server too (service role)", async () => {
    expect((await service.from("carrier_documents").insert(doc(c.id, "transport_license", { expires_at: FUTURE }))).error?.code).toBe("23514");
    expect((await service.from("carrier_documents").insert(doc(c.id, "insurance_rca", { expires_at: FUTURE }))).error?.code).toBe("23514");
  });

  it("server cannot link a vehicle of another carrier either", async () => {
    const other = await newCarrier();
    expect((await service.from("carrier_documents").insert(doc(other.id, "insurance_rca", { vehicle_id: vehicleId, expires_at: FUTURE }))).error?.code).toBe("23514");
  });

  it("file metadata and path format are checked", async () => {
    const bad = [
      { storage_path: `${c.id}/rca.pdf` },
      { storage_path: `${c.id}/${randomUUID()}.exe` },
      { storage_path: `${c.id}/sub/${randomUUID()}.pdf` },
      { mime_type: "application/zip" },
      { size_bytes: 10485761 },
      { size_bytes: 0 },
      { file_name: "" },
    ];
    for (const extra of bad) {
      const { error } = await c.client.from("carrier_documents").insert(doc(c.id, "transport_license", extra));
      expect(error, JSON.stringify(extra)).not.toBeNull();
    }
    const row = doc(c.id, "transport_license");
    expect((await c.client.from("carrier_documents").insert(row)).error).toBeNull();
    expect((await c.client.from("carrier_documents").insert({ ...row, file_name: "copia.pdf" })).error?.code).toBe("23505");
  });
});

describe("carrier_vehicles — payload and plate (D102)", () => {
  it("payload is required and the plate is normalised", async () => {
    const c = await newCarrier();
    const base = { carrier_id: c.id, vehicle_type_id: vanId };
    expect((await c.client.from("carrier_vehicles").insert({ ...base, plate: plate() })).error).not.toBeNull();
    for (const p of ["ab123cd", "AB 123CD", "AB-123-CD", "AB1", "ABCDEFGHIJK"]) {
      expect((await c.client.from("carrier_vehicles").insert({ ...base, plate: p, payload_kg: 800 })).error?.code, p).toBe("23514");
    }
    expect((await c.client.from("carrier_vehicles").insert({ ...base, plate: plate(), payload_kg: 800 })).error).toBeNull();
  });
});

describe("isolation: own data only, admin everything", () => {
  let a: { user: TestUser; vehicleId: string };
  let b: TestUser;
  let blockedCarrier: TestUser;
  let filePath: string;

  beforeAll(async () => {
    a = await completeCarrier();
    b = await newCarrier();
    blockedCarrier = (await completeCarrier()).user;
    await run(service.from("profiles").update({ is_blocked: true }).eq("id", blockedCarrier.id));
    filePath = `${a.user.id}/${randomUUID()}.pdf`;
    await run(a.user.client.storage.from(BUCKET).upload(filePath, new Blob(["%PDF-1.4 test"], { type: "application/pdf" })));
  });

  it("another carrier, a customer and anon see none of A's carrier row, vehicles and documents", async () => {
    for (const c of [b.client, cliente.client, anon]) {
      expect((await c.from("carriers").select("profile_id").eq("profile_id", a.user.id)).data ?? []).toEqual([]);
      expect((await c.from("carrier_vehicles").select("id").eq("carrier_id", a.user.id)).data ?? []).toEqual([]);
      expect((await c.from("carrier_documents").select("id").eq("carrier_id", a.user.id)).data ?? []).toEqual([]);
    }
  });

  it("the carrier sees exactly its own rows", async () => {
    const vehicles = await check(a.user.client.from("carrier_vehicles").select("carrier_id"));
    const docs = await check(a.user.client.from("carrier_documents").select("carrier_id"));
    expect(vehicles.length).toBe(1);
    expect(docs.length).toBe(4);
    expect([...vehicles, ...docs].every((r) => r.carrier_id === a.user.id)).toBe(true);
  });

  it("admin sees A's rows; a blocked admin does not", async () => {
    expect(await check(admin.client.from("carrier_documents").select("id").eq("carrier_id", a.user.id))).toHaveLength(4);
    expect(await check(admin.client.from("carrier_vehicles").select("id").eq("carrier_id", a.user.id))).toHaveLength(1);
    expect((await blockedAdmin.client.from("carrier_documents").select("id").eq("carrier_id", a.user.id)).data ?? []).toEqual([]);
  });

  it("signed URL: owner and admin can create one, other carrier and customer cannot", async () => {
    for (const c of [a.user.client, admin.client]) {
      const { data, error } = await c.storage.from(BUCKET).createSignedUrl(filePath, 300);
      expect(error).toBeNull();
      expect((await fetch(data!.signedUrl)).ok).toBe(true);
    }
    for (const c of [b.client, cliente.client, blockedAdmin.client]) {
      const { data } = await c.storage.from(BUCKET).createSignedUrl(filePath, 300);
      expect(data).toBeNull();
    }
  });

  it("a blocked carrier loses access to its own data and cannot add anything", async () => {
    const c = blockedCarrier.client;
    expect((await c.from("carrier_vehicles").select("id")).data ?? []).toEqual([]);
    expect((await c.from("carrier_documents").select("id")).data ?? []).toEqual([]);
    expect((await c.from("carrier_documents").insert(doc(blockedCarrier.id, "transport_license"))).error).not.toBeNull();
    const up = await c.storage.from(BUCKET).upload(`${blockedCarrier.id}/${randomUUID()}.pdf`, new Blob(["x"], { type: "application/pdf" }));
    expect(up.error).not.toBeNull();
    expect((await c.rpc("submit_carrier_for_review")).error?.code).toBe("42501");
  });

  it("review columns are server-only", async () => {
    for (const patch of [{ submitted_at: new Date().toISOString() }, { decided_at: new Date().toISOString() }, { decided_by: a.user.id }, { status: "active" }]) {
      const { error } = await a.user.client.from("carriers").update(patch).eq("profile_id", a.user.id);
      expect(error, JSON.stringify(patch)).not.toBeNull();
    }
  });
});

describe("carrier_onboarding_missing (D99)", () => {
  it("lists what is missing, step by step", async () => {
    const c = await createUser({ role: "padroncino" });
    await run(service.from("carriers").insert({ profile_id: c.id, company_name: "Solo Nome", vat_number: vat() }));
    expect((await missing(c)).data).toEqual(["company", "vehicle", "document:transport_license", "document:driving_license"]);

    await run(c.client.from("carriers").update(company()).eq("profile_id", c.id));
    await run(c.client.from("carrier_documents").insert(doc(c.id, "transport_license")));
    const v = await check(c.client.from("carrier_vehicles").insert({ carrier_id: c.id, vehicle_type_id: vanId, plate: plate(), payload_kg: 1000 }).select("id").single());
    expect((await missing(c)).data).toEqual([
      "document:driving_license",
      `vehicle_document:${v.id}:vehicle_registration`,
      `vehicle_document:${v.id}:insurance_rca`,
    ]);

    // expired documents and documents rejected by the admin do not count
    await run(c.client.from("carrier_documents").insert(doc(c.id, "driving_license", { expires_at: PAST })));
    const rejected = await check(c.client.from("carrier_documents").insert(doc(c.id, "vehicle_registration", { vehicle_id: v.id, expires_at: FUTURE })).select("id").single());
    await run(service.from("carrier_documents").update({ review_status: "rejected" }).eq("id", rejected.id));
    await run(c.client.from("carrier_documents").insert(doc(c.id, "insurance_rca", { vehicle_id: v.id, expires_at: FUTURE })));
    expect((await missing(c)).data).toEqual(["document:driving_license", `vehicle_document:${v.id}:vehicle_registration`]);

    // the optional RC vettoriale is never required; an inactive vehicle needs no documents
    await run(c.client.from("carrier_documents").insert([
      doc(c.id, "driving_license", { expires_at: FUTURE }),
      doc(c.id, "vehicle_registration", { vehicle_id: v.id, expires_at: FUTURE }),
    ]));
    await run(c.client.from("carrier_vehicles").insert({ carrier_id: c.id, vehicle_type_id: vanId, plate: plate(), payload_kg: 1000, is_active: false }));
    expect((await missing(c)).data).toEqual([]);
  });

  it("only the carrier itself, admin and server may call it", async () => {
    const { user: a } = await completeCarrier();
    const b = await newCarrier();
    expect((await missing(b, a.id)).error?.code).toBe("42501");
    expect((await missing(cliente, a.id)).error?.code).toBe("42501");
    expect((await anon.rpc("carrier_onboarding_missing", { p_carrier_id: a.id })).error).not.toBeNull();
    expect((await missing(admin, a.id)).data).toEqual([]);
    expect((await service.rpc("carrier_onboarding_missing", { p_carrier_id: a.id })).data).toEqual([]);
  });
});

describe("submit_carrier_for_review (D100)", () => {
  it("rejects an incomplete account and lists what is missing", async () => {
    const c = await newCarrier();
    const { error } = await c.client.rpc("submit_carrier_for_review");
    expect(error?.code).toBe("23514");
    expect(error?.details).toBe("vehicle,document:transport_license,document:driving_license");
    expect((await carrierRow(c.id)).submitted_at).toBeNull();
  });

  it("submits a complete account; a repeated call changes nothing", async () => {
    const { user } = await completeCarrier();
    const first = await check(user.client.rpc("submit_carrier_for_review"));
    expect(first).not.toBeNull();
    const second = await check(user.client.rpc("submit_carrier_for_review"));
    expect(second).toBe(first);
    expect(await carrierRow(user.id)).toMatchObject({ status: "pending_review", submitted_at: first });
  });

  it("customers and admins cannot call it", async () => {
    expect((await cliente.client.rpc("submit_carrier_for_review")).error?.code).toBe("42501");
    expect((await admin.client.rpc("submit_carrier_for_review")).error?.code).toBe("42501");
    expect((await anon.rpc("submit_carrier_for_review")).error).not.toBeNull();
  });

  it("an active or suspended account cannot be submitted", async () => {
    for (const status of ["active", "suspended"]) {
      const { user } = await completeCarrier();
      await run(service.from("carriers").update({ status }).eq("profile_id", user.id));
      expect((await user.client.rpc("submit_carrier_for_review")).error?.code).toBe("55000");
    }
  });
});

describe("decide_carrier_review (D101)", () => {
  it("cannot be called by signed-in users, admins included", async () => {
    const { user } = await completeCarrier();
    await check(user.client.rpc("submit_carrier_for_review"));
    for (const c of [admin.client, user.client, cliente.client, anon]) {
      const { error } = await c.rpc("decide_carrier_review", { p_carrier_id: user.id, p_admin_id: admin.id, p_approve: true });
      expect(error).not.toBeNull();
    }
    expect((await carrierRow(user.id)).status).toBe("pending_review");
  });

  it("p_admin_id must be an active admin", async () => {
    const { user } = await completeCarrier();
    await check(user.client.rpc("submit_carrier_for_review"));
    for (const id of [user.id, cliente.id, blockedAdmin.id, randomUUID()]) {
      expect((await decide(user.id, id, true)).error?.code).toBe("42501");
    }
  });

  it("only a submitted pending account can be decided", async () => {
    const { user } = await completeCarrier();
    expect((await decide(user.id, admin.id, true)).error?.code).toBe("55000");
  });

  it("reject: reason required; account rejected, documents untouched; the carrier can fix and resubmit", async () => {
    const { user } = await completeCarrier();
    await check(user.client.rpc("submit_carrier_for_review"));
    expect((await decide(user.id, admin.id, false)).error?.code).toBe("22023");
    expect((await decide(user.id, admin.id, false, "   ")).error?.code).toBe("22023");
    expect((await decide(user.id, admin.id, false, "x".repeat(1001))).error?.code).toBe("22023");

    expect(await check(decide(user.id, admin.id, false, "  Libretto illeggibile  "))).toBe("rejected");
    expect(await carrierRow(user.id)).toMatchObject({ status: "rejected", status_reason: "Libretto illeggibile", submitted_at: null, decided_by: admin.id });
    const own = await check(user.client.from("carriers").select("status, status_reason").single());
    expect(own).toEqual({ status: "rejected", status_reason: "Libretto illeggibile" });
    const docs = await check(service.from("carrier_documents").select("review_status").eq("carrier_id", user.id));
    expect(docs.every((d) => d.review_status === "pending")).toBe(true);

    // a second decision on the same (now cleared) submission is refused
    expect((await decide(user.id, admin.id, true)).error?.code).toBe("55000");

    await check(user.client.rpc("submit_carrier_for_review"));
    expect(await carrierRow(user.id)).toMatchObject({ status: "pending_review", status_reason: null });
  });

  it("approve: account active, documents and vehicles from the submission approved, later additions stay pending", async () => {
    const { user, vehicleId } = await completeCarrier();
    await check(user.client.rpc("submit_carrier_for_review"));
    const late = await check(user.client.from("carrier_documents").insert(doc(user.id, "goods_insurance", { expires_at: FUTURE })).select("id").single());
    const lateVehicle = await addVehicle(user);

    expect(await check(decide(user.id, admin.id, true))).toBe("active");
    const row = await carrierRow(user.id);
    expect(row).toMatchObject({ status: "active", status_reason: null, activated_by: admin.id, decided_by: admin.id });
    expect(row.activated_at).not.toBeNull();

    const docs = await check(service.from("carrier_documents").select("id, review_status, reviewed_by").eq("carrier_id", user.id));
    const approved = docs.filter((d) => d.review_status === "approved");
    expect(approved).toHaveLength(4); // Albo, patente, libretto + RCA of the first vehicle
    expect(approved.every((d) => d.reviewed_by === admin.id)).toBe(true);
    expect(docs.filter((d) => d.review_status === "pending")).toHaveLength(3); // RC vettoriale + libretto/RCA of the later vehicle
    expect(docs.find((d) => d.id === late.id)?.review_status).toBe("pending");

    const vehicles = await check(service.from("carrier_vehicles").select("id, approved_at").eq("carrier_id", user.id));
    expect(vehicles.find((v) => v.id === vehicleId)?.approved_at).not.toBeNull();
    expect(vehicles.find((v) => v.id === lateVehicle)?.approved_at).toBeNull();

    expect((await decide(user.id, admin.id, true)).error?.code).toBe("55000");
    expect((await decide(user.id, admin.id, false, "ripensamento")).error?.code).toBe("55000");
  });

  it("approve re-checks completeness (e.g. a document expired in the meantime)", async () => {
    const { user } = await completeCarrier();
    await check(user.client.rpc("submit_carrier_for_review"));
    await run(service.from("carrier_documents").update({ expires_at: PAST }).eq("carrier_id", user.id).eq("doc_type", "driving_license"));
    const { error } = await decide(user.id, admin.id, true);
    expect(error?.code).toBe("23514");
    expect(error?.details).toBe("document:driving_license");
    expect((await carrierRow(user.id)).status).toBe("pending_review");
  });
});

describe("company data lock (D105)", () => {
  const COMPANY_FIELDS = ["company_name", "vat_number", "fiscal_code", "pec", "sdi_code", "hq_street", "hq_city", "hq_postal_code", "hq_province"] as const;
  // A valid new value per field (vat_number is unique, so generated).
  const newValue = (f: (typeof COMPANY_FIELDS)[number]) =>
    ({ company_name: "Nuova Ragione Srl", vat_number: vat(), fiscal_code: "VRDLGU80A01F205X", pec: "nuova@pec.it", sdi_code: "ABC1234",
       hq_street: "Via Nuova 2", hq_city: "Torino", hq_postal_code: "10100", hq_province: "TO" })[f];
  const updateOwn = (c: TestUser, patch: Record<string, unknown>) => c.client.from("carriers").update(patch).eq("profile_id", c.id).select("profile_id");
  const adminUpdate = (carrierId: string, changes: unknown, adminId = admin.id) =>
    service.rpc("admin_update_carrier_company", { p_carrier_id: carrierId, p_admin_id: adminId, p_changes: changes });
  const auditRows = (carrierId: string) =>
    check(service.from("audit_log").select("actor_id, actor_email, action, data").eq("entity_id", carrierId).eq("action", "carrier.company_data_updated").order("id"));

  async function expectLocked(c: TestUser) {
    for (const f of COMPANY_FIELDS) {
      const { error } = await updateOwn(c, { [f]: newValue(f) });
      expect(error?.code, f).toBe("42501");
    }
    const { error } = await service.from("carriers").update({ company_name: "Diretta Srl" }).eq("profile_id", c.id);
    expect(error?.code, "service role").toBe("42501");
  }

  it("before submission the carrier edits its company data", async () => {
    const c = await newCarrier();
    for (const f of COMPANY_FIELDS) {
      const { data, error } = await updateOwn(c, { [f]: newValue(f) });
      expect(error, f).toBeNull();
      expect(data, f).toHaveLength(1);
    }
  });

  it("locked while waiting for review (submitted_at set)", async () => {
    const { user } = await completeCarrier();
    await check(user.client.rpc("submit_carrier_for_review"));
    await expectLocked(user);
  });

  it("locked when active and when suspended", async () => {
    const { user } = await completeCarrier();
    await check(user.client.rpc("submit_carrier_for_review"));
    await check(decide(user.id, admin.id, true));
    await expectLocked(user);
    await run(service.from("carriers").update({ status: "suspended" }).eq("profile_id", user.id));
    await expectLocked(user);
  });

  it("editable again after a rejection; other columns stay untouched by the lock", async () => {
    const { user } = await completeCarrier();
    await check(user.client.rpc("submit_carrier_for_review"));
    await check(decide(user.id, admin.id, false, "P.IVA errata"));
    const { data, error } = await updateOwn(user, { vat_number: vat(), hq_city: "Bergamo" });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    // the service role may change the data directly while it is not locked
    expect((await service.from("carriers").update({ hq_street: "Via Corretta 3" }).eq("profile_id", user.id)).error).toBeNull();
  });

  it("admin changes locked data through the function; audit_log has field names only", async () => {
    const { user } = await completeCarrier();
    await check(user.client.rpc("submit_carrier_for_review"));
    await check(decide(user.id, admin.id, true));
    const newVat = vat();

    const changed = await check(adminUpdate(user.id, { vat_number: newVat, hq_city: "  Genova ", hq_province: "MI" }));
    expect(changed).toEqual(["vat_number", "hq_city"]); // hq_province was already "MI"
    const row = await check(service.from("carriers").select("vat_number, hq_city, hq_province").eq("profile_id", user.id).single());
    expect(row).toEqual({ vat_number: newVat, hq_city: "Genova", hq_province: "MI" });

    const audit = await auditRows(user.id);
    expect(audit).toEqual([{ actor_id: admin.id, actor_email: admin.email, action: "carrier.company_data_updated", data: { fields: ["vat_number", "hq_city"] } }]);
    expect(JSON.stringify(audit)).not.toContain(newVat);
    expect(JSON.stringify(audit)).not.toContain("Genova");

    // blank → null; nothing changed → no write and no audit entry
    expect(await check(adminUpdate(user.id, { hq_street: "  " }))).toEqual(["hq_street"]);
    expect((await check(service.from("carriers").select("hq_street").eq("profile_id", user.id).single())).hq_street).toBeNull();
    expect((await adminUpdate(user.id, { hq_city: "Genova", pec: null, hq_street: "" })).data).toEqual([]);
    expect(await auditRows(user.id)).toHaveLength(2);
  });

  it("the function accepts only company fields, text values and an active admin; only the server calls it", async () => {
    const { user } = await completeCarrier();
    for (const changes of [{ status: "active" }, { stripe_account_id: "acct_x" }, { submitted_at: null }, { company_name: 5 }, ["company_name"], "x"]) {
      expect((await adminUpdate(user.id, changes)).error?.code, JSON.stringify(changes)).toBe("22023");
    }
    for (const id of [user.id, cliente.id, blockedAdmin.id, randomUUID()]) {
      expect((await adminUpdate(user.id, { hq_city: "Pisa" }, id)).error?.code).toBe("42501");
    }
    for (const c of [admin.client, user.client, cliente.client, anon]) {
      const { error } = await c.rpc("admin_update_carrier_company", { p_carrier_id: user.id, p_admin_id: admin.id, p_changes: { hq_city: "Pisa" } });
      expect(error).not.toBeNull();
    }
    expect(await auditRows(user.id)).toEqual([]);
  });

  it("no session flag unlocks the data for the carrier or the service role (SQL level)", async () => {
    const { user } = await completeCarrier();
    await check(user.client.rpc("submit_carrier_for_review"));
    const claims = JSON.stringify({ sub: user.id, role: "authenticated" });
    const flags = `
      select set_config('transigo.carrier_company_edit', 'on', true);
      select set_config('transigo.carrier_company_edit', 'on', false);
      select set_config('app.admin', 'true', true);`;

    // carrier: the update targets its own visible row, so without the lock it would succeed
    const asCarrier = localSql(`
      begin;
      ${flags}
      select set_config('request.jwt.claims', '${claims}', true);
      set local role authenticated;
      update public.carriers set company_name = 'Flag Srl' where profile_id = '${user.id}';
      rollback;`);
    expect(asCarrier.ok).toBe(false);
    expect(asCarrier.output).toContain("42501");

    const asService = localSql(`
      begin;
      ${flags}
      set local role service_role;
      update public.carriers set company_name = 'Flag Srl' where profile_id = '${user.id}';
      rollback;`);
    expect(asService.ok).toBe(false);
    expect(asService.output).toContain("42501");

    // control: the same carrier session works on unlocked data (the SQL above is not failing for another reason)
    await check(decide(user.id, admin.id, false, "controllo"));
    const control = localSql(`
      begin;
      select set_config('request.jwt.claims', '${claims}', true);
      set local role authenticated;
      update public.carriers set company_name = 'Controllo Srl' where profile_id = '${user.id}' returning profile_id;
      rollback;`);
    expect(control.output).toContain(user.id);
    expect(control.ok).toBe(true);

    expect((await check(service.from("carriers").select("company_name").eq("profile_id", user.id).single())).company_name).toBe("Trasporti Test Srl");
  });
});
