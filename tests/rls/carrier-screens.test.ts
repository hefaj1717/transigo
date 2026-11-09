import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AUTH_MSG } from "@/lib/auth/errors";
import { ONBOARDING_MSG } from "@/lib/carriers/onboarding";
import { DOCUMENT_MSG } from "@/lib/carriers/documents";
import { createCarrierVehicle, registerCarrierDocument, saveCarrierCompany, setCarrierVehicleActive, updateCarrierVehicle } from "@/lib/carriers/server";
import { VEHICLE_MSG } from "@/lib/carriers/vehicles";
import { createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";

// Stage 4.1 step 3 — logic behind the carrier screens "Dati aziendali" and "Veicoli" (src/lib/carriers/server.ts),
// run with the carrier's own session against the local database: state checks (D105, D109, D112),
// Italian messages for database errors (D107, D111), no writes for another carrier's vehicle.

const FUTURE = "2099-12-31";
const plate = () => `TG${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const vat = () => `IT${Math.floor(Math.random() * 1e11).toString().padStart(11, "0")}`;
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

// Valid Italian VAT number / fiscal code / SDI for the form schema.
const companyForm = (extra: Record<string, string> = {}) => ({
  companyName: "Trasporti Nuovi Srl", vatNumber: "00743110157", fiscalCode: "00743110157",
  hqStreet: "Via Milano 5", hqCity: "Torino", hqPostalCode: "10121", hqProvince: "to", sdiCode: "m5uxcr1", pec: "", ...extra,
});

let vanId: string;
let largeId: string;
let inactiveTypeId: string;
let admin: TestUser;

async function newCarrier(): Promise<TestUser> {
  const u = await createUser({ role: "padroncino" });
  await run(service.from("carriers").insert({
    profile_id: u.id, company_name: "Trasporti Test Srl", vat_number: vat(), fiscal_code: "RSSMRA80A01H501U",
    hq_street: "Via Roma 1", hq_city: "Milano", hq_postal_code: "20100", hq_province: "MI", sdi_code: "M5UXCR1",
  }));
  return u;
}

const doc = (c: TestUser, docType: string, extra: Record<string, unknown> = {}) => ({
  carrier_id: c.id, doc_type: docType, storage_path: `${c.id}/${randomUUID()}.pdf`,
  file_name: "documento.pdf", mime_type: "application/pdf", size_bytes: 2048, ...extra,
});

/** Complete carrier sent for review; returns the vehicle id. */
async function submittedCarrier(): Promise<{ user: TestUser; vehicleId: string }> {
  const user = await newCarrier();
  const v = await check(user.client.from("carrier_vehicles").insert({ carrier_id: user.id, vehicle_type_id: vanId, plate: plate(), payload_kg: 1000 }).select("id").single());
  await run(user.client.from("carrier_documents").insert([
    doc(user, "transport_license"),
    doc(user, "driving_license", { expires_at: FUTURE }),
    doc(user, "vehicle_registration", { vehicle_id: v.id, expires_at: FUTURE }),
    doc(user, "insurance_rca", { vehicle_id: v.id, expires_at: FUTURE }),
  ]));
  await check(user.client.rpc("submit_carrier_for_review"));
  return { user, vehicleId: v.id };
}

async function activeCarrier() {
  const c = await submittedCarrier();
  await check(service.rpc("decide_carrier_review", { p_carrier_id: c.user.id, p_admin_id: admin.id, p_approve: true, p_reason: null }));
  return c;
}

const vehicleForm = (extra: Record<string, string> = {}) => ({ vehicleTypeId: vanId, plate: plate(), payloadKg: "1200", ...extra });
const vehicleRow = (id: string) =>
  check(service.from("carrier_vehicles").select("plate, vehicle_type_id, payload_kg, is_active, approved_at, first_approved_at").eq("id", id).single());

beforeAll(async () => {
  const types = await check(service.from("vehicle_types").select("id, code"));
  vanId = types.find((t) => t.code === "van_medium")!.id;
  largeId = types.find((t) => t.code === "van_large")!.id;
  inactiveTypeId = (await check(service.from("vehicle_types").insert({ code: `test_${randomUUID().slice(0, 6)}`, name_it: "Tipo dismesso", size_rank: 900 + Math.floor(Math.random() * 90), is_active: false }).select("id").single())).id;
  admin = await createUser({});
  await run(service.from("profiles").update({ role: "admin" }).eq("id", admin.id));
});

afterAll(async () => {
  await service.from("vehicle_types").delete().eq("id", inactiveTypeId);
  await deleteCreatedUsers();
});

describe("Dati aziendali (D45, D105)", () => {
  it("saves normalised data while the account was not sent", async () => {
    const c = await newCarrier();
    const r = await saveCarrierCompany(c.client, c.id, companyForm());
    expect(r).toEqual({ ok: true, data: undefined });
    expect(await check(service.from("carriers").select("company_name, hq_province, sdi_code, pec").eq("profile_id", c.id).single()))
      .toEqual({ company_name: "Trasporti Nuovi Srl", hq_province: "TO", sdi_code: "M5UXCR1", pec: null });
  });

  it("form errors per field, nothing saved", async () => {
    const c = await newCarrier();
    const r = await saveCarrierCompany(c.client, c.id, companyForm({ vatNumber: "123", sdiCode: "", pec: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["sdiCode", "vatNumber"]);
  });

  it("a VAT number of another carrier → message on the field", async () => {
    const [a, b] = await Promise.all([newCarrier(), newCarrier()]);
    // the schema accepts only valid Italian numbers, so give A a valid one and let B try to use it
    await run(service.from("carriers").update({ vat_number: "01234567897" }).eq("profile_id", a.id));
    const r = await saveCarrierCompany(b.client, b.id, companyForm({ vatNumber: "01234567897" }));
    expect(r).toEqual({ ok: false, errors: { vatNumber: AUTH_MSG.vatTaken } });
  });

  it("in review: refused with the review message; active: locked (D105)", async () => {
    const { user } = await submittedCarrier();
    expect(await saveCarrierCompany(user.client, user.id, companyForm())).toEqual({ ok: false, errors: { _form: ONBOARDING_MSG.inReview } });
    await check(service.rpc("decide_carrier_review", { p_carrier_id: user.id, p_admin_id: admin.id, p_approve: true, p_reason: null }));
    expect(await saveCarrierCompany(user.client, user.id, companyForm())).toEqual({ ok: false, errors: { _form: ONBOARDING_MSG.companyLocked } });
    expect((await check(service.from("carriers").select("company_name").eq("profile_id", user.id).single())).company_name).toBe("Trasporti Test Srl");
  });

  it("after a rejection the data can be corrected", async () => {
    const { user } = await submittedCarrier();
    await check(service.rpc("decide_carrier_review", { p_carrier_id: user.id, p_admin_id: admin.id, p_approve: false, p_reason: "P.IVA errata" }));
    expect((await saveCarrierCompany(user.client, user.id, companyForm({ vatNumber: "00488410010", fiscalCode: "00488410010" }))).ok).toBe(true);
  });
});

describe("Veicoli (D102, D107, D111, D112)", () => {
  it("adds a vehicle with a normalised plate", async () => {
    const c = await newCarrier();
    const p = plate();
    const r = await createCarrierVehicle(c.client, c.id, vehicleForm({ plate: `${p.slice(0, 2).toLowerCase()} ${p.slice(2, 5)}-${p.slice(5)}` }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(await vehicleRow(r.data.id)).toMatchObject({ plate: p, payload_kg: 1200, approved_at: null });
  });

  it("a plate already registered (by anyone) → D111 message", async () => {
    const [a, b] = await Promise.all([newCarrier(), newCarrier()]);
    const p = plate();
    expect((await createCarrierVehicle(a.client, a.id, vehicleForm({ plate: p }))).ok).toBe(true);
    expect(await createCarrierVehicle(b.client, b.id, vehicleForm({ plate: p }))).toEqual({
      ok: false, errors: { plate: VEHICLE_MSG.plateTaken }, offerNewVehicle: false,
    });
  });

  it("an inactive or unknown vehicle type is refused", async () => {
    const c = await newCarrier();
    for (const vehicleTypeId of [inactiveTypeId, randomUUID()]) {
      expect(await createCarrierVehicle(c.client, c.id, vehicleForm({ vehicleTypeId }))).toEqual({ ok: false, errors: { vehicleTypeId: VEHICLE_MSG.vehicleType } });
    }
  });

  it("in review and suspended: no vehicle changes (D109, D112)", async () => {
    const { user, vehicleId } = await submittedCarrier();
    const before = await vehicleRow(vehicleId);
    expect(await createCarrierVehicle(user.client, user.id, vehicleForm())).toEqual({ ok: false, errors: { _form: ONBOARDING_MSG.inReview } });
    expect(await updateCarrierVehicle(user.client, user.id, vehicleId, vehicleForm({ payloadKg: "900" }))).toEqual({ ok: false, errors: { _form: ONBOARDING_MSG.inReview } });
    expect(await setCarrierVehicleActive(user.client, user.id, vehicleId, false)).toEqual({ ok: false, errors: { _form: ONBOARDING_MSG.inReview } });

    await check(service.rpc("decide_carrier_review", { p_carrier_id: user.id, p_admin_id: admin.id, p_approve: true, p_reason: null }));
    await run(service.from("carriers").update({ status: "suspended", status_reason: "test" }).eq("profile_id", user.id));
    expect(await createCarrierVehicle(user.client, user.id, vehicleForm())).toEqual({ ok: false, errors: { _form: ONBOARDING_MSG.notEditable } });
    expect((await vehicleRow(vehicleId)).payload_kg).toBe(before.payload_kg);
  });

  it("active carrier: plate of the approved vehicle locked with the button flag; type change sends it back to the admin", async () => {
    const { user, vehicleId } = await activeCarrier();
    const current = await vehicleRow(vehicleId);
    expect(await updateCarrierVehicle(user.client, user.id, vehicleId, vehicleForm({ plate: plate() }))).toEqual({
      ok: false, errors: { plate: VEHICLE_MSG.plateLocked }, offerNewVehicle: true,
    });
    const r = await updateCarrierVehicle(user.client, user.id, vehicleId, vehicleForm({ plate: current.plate, vehicleTypeId: largeId }));
    expect(r.ok).toBe(true);
    expect(await vehicleRow(vehicleId)).toMatchObject({ plate: current.plate, vehicle_type_id: largeId, approved_at: null, first_approved_at: current.first_approved_at });
  });

  it("active carrier can add a new vehicle (D112); it waits for approval", async () => {
    const { user } = await activeCarrier();
    const r = await createCarrierVehicle(user.client, user.id, vehicleForm());
    expect(r.ok).toBe(true);
    if (r.ok) expect(await vehicleRow(r.data.id)).toMatchObject({ approved_at: null, first_approved_at: null });
  });

  it("before approval the plate can be corrected", async () => {
    const c = await newCarrier();
    const r = await createCarrierVehicle(c.client, c.id, vehicleForm());
    if (!r.ok) throw new Error("create failed");
    const p = plate();
    expect((await updateCarrierVehicle(c.client, c.id, r.data.id, vehicleForm({ plate: p }))).ok).toBe(true);
    expect((await vehicleRow(r.data.id)).plate).toBe(p);
  });

  it("deactivation keeps the approval; another carrier's vehicle is not found", async () => {
    const { user, vehicleId } = await activeCarrier();
    const other = await newCarrier();
    expect(await setCarrierVehicleActive(other.client, other.id, vehicleId, false)).toEqual({ ok: false, errors: { _form: "Veicolo non trovato." } });
    expect(await updateCarrierVehicle(other.client, other.id, vehicleId, vehicleForm())).toEqual({ ok: false, errors: { _form: "Veicolo non trovato." } });

    const before = await vehicleRow(vehicleId);
    expect((await setCarrierVehicleActive(user.client, user.id, vehicleId, false)).ok).toBe(true);
    expect(await vehicleRow(vehicleId)).toEqual({ ...before, is_active: false });
    expect((await setCarrierVehicleActive(user.client, user.id, vehicleId, true)).ok).toBe(true);
    expect(await vehicleRow(vehicleId)).toEqual(before);
  });
});

describe("Documenti — upload and record (D98, D103, D112)", () => {
  const BUCKET = "carrier-documents";
  const PDF = new Blob(["%PDF-1.4 test document"], { type: "application/pdf" });

  /** Uploads like the browser does (carrier session, own folder) and returns the path. */
  async function upload(c: TestUser, ext = "pdf", blob: Blob = PDF, contentType = "application/pdf", folder = c.id) {
    const path = `${folder}/${randomUUID()}.${ext}`;
    await run(c.client.storage.from(BUCKET).upload(path, blob, { contentType }));
    return path;
  }
  const form = (path: string, extra: Record<string, string> = {}) => ({ docType: "driving_license", storagePath: path, fileName: "patente.pdf", expiresAt: FUTURE, ...extra });
  const docRow = (id: string) => check(service.from("carrier_documents").select("doc_type, vehicle_id, expires_at, file_name, mime_type, size_bytes, review_status").eq("id", id).single());

  it("records the uploaded file with size and type from Storage, not from the form", async () => {
    const c = await newCarrier();
    const path = await upload(c);
    const r = await registerCarrierDocument(c.client, c.id, { ...form(path), mimeType: "image/png", sizeBytes: "1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(await docRow(r.data.id)).toEqual({
        doc_type: "driving_license", vehicle_id: null, expires_at: FUTURE, file_name: "patente.pdf",
        mime_type: "application/pdf", size_bytes: PDF.size, review_status: "pending",
      });
    }
    const missing = await check(c.client.rpc("carrier_onboarding_missing", { p_carrier_id: c.id }));
    expect(missing).not.toContain("document:driving_license");
  });

  it("a file that is not in Storage, or in another carrier's folder, is refused", async () => {
    const [a, b] = await Promise.all([newCarrier(), newCarrier()]);
    expect(await registerCarrierDocument(a.client, a.id, form(`${a.id}/${randomUUID()}.pdf`))).toEqual({ ok: false, errors: { _form: DOCUMENT_MSG.fileMissing } });
    const bPath = await upload(b);
    expect(await registerCarrierDocument(a.client, a.id, form(bPath))).toEqual({ ok: false, errors: { _form: DOCUMENT_MSG.fileMissing } });
  });

  it("the stored type must match the path extension", async () => {
    const c = await newCarrier();
    const path = await upload(c, "pdf", new Blob(["png"], { type: "image/png" }), "image/png");
    expect(await registerCarrierDocument(c.client, c.id, form(path))).toEqual({ ok: false, errors: { _form: DOCUMENT_MSG.type } });
  });

  it("date rules per type: expired or missing date refused, Albo without date", async () => {
    const c = await newCarrier();
    const path = await upload(c);
    expect(await registerCarrierDocument(c.client, c.id, form(path, { expiresAt: "2020-01-01" }))).toEqual({ ok: false, errors: { expiresAt: DOCUMENT_MSG.expired } });
    expect(await registerCarrierDocument(c.client, c.id, form(path, { expiresAt: "" }))).toEqual({ ok: false, errors: { expiresAt: DOCUMENT_MSG.dateRequired("Scadenza") } });
    expect(await registerCarrierDocument(c.client, c.id, form(path, { docType: "transport_license", expiresAt: "2030-01-01" }))).toEqual({ ok: false, errors: { expiresAt: DOCUMENT_MSG.dateNotAllowed } });
    expect((await registerCarrierDocument(c.client, c.id, form(path, { docType: "transport_license", expiresAt: "" }))).ok).toBe(true);
  });

  it("vehicle documents: own active vehicle only", async () => {
    const [a, b] = await Promise.all([newCarrier(), newCarrier()]);
    const va = await createCarrierVehicle(a.client, a.id, vehicleForm());
    const vb = await createCarrierVehicle(b.client, b.id, vehicleForm());
    if (!va.ok || !vb.ok) throw new Error("vehicles not created");
    const rca = (path: string, vehicleId: string) => form(path, { docType: "insurance_rca", vehicleId });

    expect((await registerCarrierDocument(a.client, a.id, rca(await upload(a), vb.data.id))).ok).toBe(false);
    expect(await registerCarrierDocument(a.client, a.id, form(await upload(a), { docType: "insurance_rca" }))).toMatchObject({ ok: false, errors: { vehicleId: DOCUMENT_MSG.vehicle } });
    const ok = await registerCarrierDocument(a.client, a.id, rca(await upload(a), va.data.id));
    expect(ok.ok).toBe(true);

    await setCarrierVehicleActive(a.client, a.id, va.data.id, false);
    expect((await registerCarrierDocument(a.client, a.id, rca(await upload(a), va.data.id))).ok).toBe(false);
  });

  it("the same file cannot be recorded twice", async () => {
    const c = await newCarrier();
    const path = await upload(c);
    expect((await registerCarrierDocument(c.client, c.id, form(path))).ok).toBe(true);
    expect(await registerCarrierDocument(c.client, c.id, form(path))).toEqual({ ok: false, errors: { _form: "Questo file è già stato registrato." } });
  });

  it("in review: refused (D109); active: a renewal can be uploaded (D112)", async () => {
    const { user } = await submittedCarrier();
    expect(await registerCarrierDocument(user.client, user.id, form(await upload(user)))).toEqual({ ok: false, errors: { _form: ONBOARDING_MSG.inReview } });
    await check(service.rpc("decide_carrier_review", { p_carrier_id: user.id, p_admin_id: admin.id, p_approve: true, p_reason: null }));
    const r = await registerCarrierDocument(user.client, user.id, form(await upload(user)));
    expect(r.ok).toBe(true);
    if (r.ok) expect((await docRow(r.data.id)).review_status).toBe("pending");
  });
});
