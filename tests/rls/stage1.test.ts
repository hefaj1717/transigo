import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, profileRole, service, type TestUser } from "./helpers";

// Stage 1 security tests: accounts, roles, carrier vehicles/documents, settings, audit log, storage.
// See docs/db-schema.md (sections 3.1, 3.2, 5, 6, 9).

let clienteA: TestUser; // signed up asking for role "admin" → must become cliente
let clienteB: TestUser;
let carrierA: TestUser;
let carrierB: TestUser;
let admin: TestUser;
let blocked: TestUser;

// Valid plate (D102): upper-case letters and digits.
const plate = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
// Valid document row (D98): {carrier}/{uuid}.pdf + file metadata.
const doc = (carrierId: string, docType: string, extra: Record<string, unknown> = {}) => ({
  carrier_id: carrierId, doc_type: docType, storage_path: `${carrierId}/${randomUUID()}.pdf`,
  file_name: "documento.pdf", mime_type: "application/pdf", size_bytes: 1024, ...extra,
});

const vat = () => `IT${Math.floor(Math.random() * 1e11).toString().padStart(11, "0")}`;

beforeAll(async () => {
  clienteA = await createUser({ role: "admin", first_name: "Anna" });
  clienteB = await createUser({});
  carrierA = await createUser({ role: "padroncino" });
  carrierB = await createUser({ role: "padroncino" });
  admin = await createUser({});
  blocked = await createUser({});

  // Server-side setup (what the registration route handler will do).
  const setup = await Promise.all([
    service.from("profiles").update({ role: "admin" }).eq("id", admin.id),
    service.from("profiles").update({ is_blocked: true }).eq("id", blocked.id),
    service.from("customers").insert([
      { profile_id: clienteA.id, customer_type: "private", fiscal_code: "RSSMRA80A01H501U" },
      { profile_id: clienteB.id, customer_type: "business", company_name: "Beta Srl", vat_number: vat(), sdi_code: "M5UXCR1" },
      { profile_id: blocked.id, customer_type: "private", fiscal_code: "BLCKDU80A01H501U" },
    ]),
    service.from("carriers").insert([
      { profile_id: carrierA.id, company_name: "Trasporti A", vat_number: vat() },
      { profile_id: carrierB.id, company_name: "Trasporti B", vat_number: vat() },
    ]),
  ]);
  for (const r of setup) if (r.error) throw r.error;
});

afterAll(async () => {
  await deleteCreatedUsers();
});

describe("role assignment (handle_new_user trigger)", () => {
  it("sign-up metadata role=admin becomes cliente", async () => {
    expect(await profileRole(clienteA.id)).toBe("cliente");
  });
  it("no role in metadata becomes cliente", async () => {
    expect(await profileRole(clienteB.id)).toBe("cliente");
  });
  it("role=padroncino is honoured", async () => {
    expect(await profileRole(carrierA.id)).toBe("padroncino");
  });
  it("profile copies e-mail and first name from sign-up", async () => {
    const { data } = await clienteA.client.from("profiles").select("email, first_name").single();
    expect(data).toEqual({ email: clienteA.email, first_name: "Anna" });
  });
  it("changing user_metadata.role after sign-up does not change the profile role", async () => {
    const { error } = await clienteB.client.auth.updateUser({ data: { role: "admin" } });
    expect(error).toBeNull();
    expect(await profileRole(clienteB.id)).toBe("cliente");
  });
});

describe("profiles", () => {
  it("user cannot change own role", async () => {
    const { error } = await clienteA.client.from("profiles").update({ role: "admin" }).eq("id", clienteA.id);
    expect(error).not.toBeNull();
    expect(await profileRole(clienteA.id)).toBe("cliente");
  });
  it("user cannot unblock / change server-only columns", async () => {
    for (const patch of [{ is_blocked: true }, { email: "x@example.com" }, { privacy_accepted_at: new Date().toISOString() }]) {
      const { error } = await clienteA.client.from("profiles").update(patch).eq("id", clienteA.id);
      expect(error, JSON.stringify(patch)).not.toBeNull();
    }
  });
  it("user can edit own name and phone", async () => {
    const { data, error } = await clienteA.client
      .from("profiles").update({ last_name: "Rossi", phone: "+390000000000" }).eq("id", clienteA.id).select("last_name");
    expect(error).toBeNull();
    expect(data).toEqual([{ last_name: "Rossi" }]);
  });
  it("user sees only own profile", async () => {
    const { data } = await clienteA.client.from("profiles").select("id");
    expect(data?.map((r) => r.id)).toEqual([clienteA.id]);
  });
  it("user cannot edit another profile", async () => {
    const { data } = await clienteA.client.from("profiles").update({ first_name: "Hacked" }).eq("id", clienteB.id).select();
    expect(data).toEqual([]);
    const { data: b } = await service.from("profiles").select("first_name").eq("id", clienteB.id).single();
    expect(b?.first_name).not.toBe("Hacked");
  });
  it("user cannot insert or delete profiles", async () => {
    const ins = await clienteA.client.from("profiles").insert({ id: randomUUID(), email: "z@example.com" });
    expect(ins.error).not.toBeNull();
    const del = await clienteA.client.from("profiles").delete().eq("id", clienteA.id);
    expect(del.error).not.toBeNull();
  });
  it("anon cannot read profiles", async () => {
    const { data } = await anon.from("profiles").select("id");
    expect(data ?? []).toEqual([]);
  });
  it("admin reads all profiles", async () => {
    const ids = [clienteA.id, clienteB.id, carrierA.id, carrierB.id, blocked.id];
    const { data } = await admin.client.from("profiles").select("id").in("id", ids);
    expect(data).toHaveLength(ids.length);
  });
  it("admin cannot change roles through the API either (server/SQL only)", async () => {
    const { error } = await admin.client.from("profiles").update({ role: "admin" }).eq("id", clienteB.id);
    expect(error).not.toBeNull();
    expect(await profileRole(clienteB.id)).toBe("cliente");
  });
});

describe("blocked account", () => {
  it("blocked user sees nothing, not even own profile/customer row", async () => {
    const p = await blocked.client.from("profiles").select("id");
    const c = await blocked.client.from("customers").select("profile_id");
    expect(p.data ?? []).toEqual([]);
    expect(c.data ?? []).toEqual([]);
  });
  it("blocked user cannot edit own profile", async () => {
    const { data } = await blocked.client.from("profiles").update({ first_name: "X" }).eq("id", blocked.id).select();
    expect(data ?? []).toEqual([]);
  });
});

describe("customers", () => {
  it("customer sees only own row", async () => {
    const { data } = await clienteA.client.from("customers").select("profile_id");
    expect(data?.map((r) => r.profile_id)).toEqual([clienteA.id]);
  });
  it("customer can edit billing data", async () => {
    const { data, error } = await clienteA.client
      .from("customers").update({ billing_city: "Milano" }).eq("profile_id", clienteA.id).select("billing_city");
    expect(error).toBeNull();
    expect(data).toEqual([{ billing_city: "Milano" }]);
  });
  it("customer cannot change customer_type (private/business)", async () => {
    const { error } = await clienteA.client.from("customers").update({ customer_type: "business" }).eq("profile_id", clienteA.id);
    expect(error).not.toBeNull();
  });
  it("customer cannot create a customer row (server only)", async () => {
    const { error } = await clienteA.client.from("customers").insert({ profile_id: clienteA.id, customer_type: "private", fiscal_code: "X" });
    expect(error).not.toBeNull();
  });
  it("carriers cannot read customers", async () => {
    const { data } = await carrierA.client.from("customers").select("profile_id");
    expect(data ?? []).toEqual([]);
  });
});

describe("carriers", () => {
  it("carrier sees only own row; customers see none", async () => {
    const own = await carrierA.client.from("carriers").select("profile_id");
    expect(own.data?.map((r) => r.profile_id)).toEqual([carrierA.id]);
    const cust = await clienteA.client.from("carriers").select("profile_id");
    expect(cust.data ?? []).toEqual([]);
  });
  it("carrier can edit company address", async () => {
    const { data, error } = await carrierA.client
      .from("carriers").update({ hq_city: "Torino" }).eq("profile_id", carrierA.id).select("hq_city");
    expect(error).toBeNull();
    expect(data).toEqual([{ hq_city: "Torino" }]);
  });
  it("carrier cannot activate itself or fake Stripe / SMS verification", async () => {
    for (const patch of [
      { status: "active" },
      { stripe_payouts_enabled: true },
      { stripe_account_id: "acct_fake" },
      { phone_verified_at: new Date().toISOString() },
      { activated_at: new Date().toISOString() },
    ]) {
      const { error } = await carrierA.client.from("carriers").update(patch).eq("profile_id", carrierA.id);
      expect(error, JSON.stringify(patch)).not.toBeNull();
    }
    const { data } = await service.from("carriers").select("status, stripe_payouts_enabled").eq("profile_id", carrierA.id).single();
    expect(data).toEqual({ status: "pending_review", stripe_payouts_enabled: false });
  });
  it("customer cannot create a carrier row", async () => {
    const { error } = await clienteA.client.from("carriers").insert({ profile_id: clienteA.id, company_name: "X", vat_number: vat() });
    expect(error).not.toBeNull();
  });
});

describe("vehicle_types", () => {
  it("anon reads the 5 starting types in size order", async () => {
    const { data } = await anon.from("vehicle_types").select("code, size_rank").order("size_rank");
    expect(data?.map((r) => r.code)).toEqual(["car", "van_small", "van_medium", "van_large", "truck_tail_lift"]);
  });
  it("anon, customer and carrier cannot create or edit types", async () => {
    for (const c of [anon, clienteA.client, carrierA.client]) {
      const ins = await c.from("vehicle_types").insert({ code: `x_${randomUUID()}`, name_it: "X", size_rank: 99 });
      expect(ins.error).not.toBeNull();
      const upd = await c.from("vehicle_types").update({ name_it: "Hacked" }).eq("code", "car").select();
      expect(upd.data ?? []).toEqual([]);
    }
  });
  it("admin can create a type; inactive types are hidden from the public", async () => {
    const code = `rls_${randomUUID().slice(0, 8)}`;
    const { error } = await admin.client.from("vehicle_types").insert({ code, name_it: "Test", size_rank: 900 + Math.floor(Math.random() * 99), is_active: false });
    expect(error).toBeNull();
    const pub = await anon.from("vehicle_types").select("code").eq("code", code);
    expect(pub.data).toEqual([]);
    const adm = await admin.client.from("vehicle_types").select("code").eq("code", code);
    expect(adm.data).toEqual([{ code }]);
    await service.from("vehicle_types").delete().eq("code", code);
  });
});

describe("carrier_vehicles", () => {
  let vanSmallId: string;
  let vanLargeId: string;
  let vehicleId: string;

  beforeAll(async () => {
    const { data } = await service.from("vehicle_types").select("id, code").in("code", ["van_small", "van_large"]);
    vanSmallId = data!.find((t) => t.code === "van_small")!.id;
    vanLargeId = data!.find((t) => t.code === "van_large")!.id;
  });

  it("carrier adds own vehicle", async () => {
    const { data, error } = await carrierA.client
      .from("carrier_vehicles")
      .insert({ carrier_id: carrierA.id, vehicle_type_id: vanSmallId, plate: plate("AA"), payload_kg: 1000 })
      .select("id")
      .single();
    expect(error).toBeNull();
    vehicleId = data!.id;
  });
  it("carrier cannot add a vehicle for another carrier", async () => {
    const { error } = await carrierA.client
      .from("carrier_vehicles").insert({ carrier_id: carrierB.id, vehicle_type_id: vanSmallId, plate: plate("BB"), payload_kg: 1000 });
    expect(error).not.toBeNull();
  });
  it("carrier cannot self-approve a vehicle", async () => {
    const ins = await carrierA.client.from("carrier_vehicles").insert({
      carrier_id: carrierA.id, vehicle_type_id: vanSmallId, plate: plate("CC"), payload_kg: 1000, approved_at: new Date().toISOString(),
    });
    expect(ins.error).not.toBeNull();
    const upd = await carrierA.client.from("carrier_vehicles").update({ approved_at: new Date().toISOString() }).eq("id", vehicleId);
    expect(upd.error).not.toBeNull();
  });
  it("changing vehicle type after approval removes the approval", async () => {
    await service.from("carrier_vehicles").update({ approved_at: new Date().toISOString() }).eq("id", vehicleId);
    const { error } = await carrierA.client.from("carrier_vehicles").update({ vehicle_type_id: vanLargeId }).eq("id", vehicleId);
    expect(error).toBeNull();
    const { data } = await service.from("carrier_vehicles").select("approved_at").eq("id", vehicleId).single();
    expect(data?.approved_at).toBeNull();
  });
  it("other carrier and customers cannot see or edit it", async () => {
    for (const c of [carrierB.client, clienteA.client]) {
      const sel = await c.from("carrier_vehicles").select("id").eq("id", vehicleId);
      expect(sel.data ?? []).toEqual([]);
      const upd = await c.from("carrier_vehicles").update({ is_active: false }).eq("id", vehicleId).select();
      expect(upd.data ?? []).toEqual([]);
    }
  });
  it("customer cannot add vehicles", async () => {
    const { error } = await clienteA.client
      .from("carrier_vehicles").insert({ carrier_id: clienteA.id, vehicle_type_id: vanSmallId, plate: plate("DD"), payload_kg: 1000 });
    expect(error).not.toBeNull();
  });
  it("carrier cannot delete vehicles (deactivate instead)", async () => {
    const { error } = await carrierA.client.from("carrier_vehicles").delete().eq("id", vehicleId);
    expect(error).not.toBeNull();
  });
  it("admin sees all vehicles", async () => {
    const { data } = await admin.client.from("carrier_vehicles").select("id").eq("id", vehicleId);
    expect(data).toHaveLength(1);
  });
});

describe("carrier_documents (table)", () => {
  let docId: string;

  it("carrier registers a document in own folder", async () => {
    const { data, error } = await carrierA.client
      .from("carrier_documents")
      .insert(doc(carrierA.id, "driving_license", { expires_at: "2027-12-31" }))
      .select("id, review_status")
      .single();
    expect(error).toBeNull();
    expect(data?.review_status).toBe("pending");
    docId = data!.id;
  });
  it("carrier cannot point a document at another carrier's folder", async () => {
    const { error } = await carrierA.client
      .from("carrier_documents").insert(doc(carrierA.id, "transport_license", { storage_path: `${carrierB.id}/${randomUUID()}.pdf` }));
    expect(error).not.toBeNull();
  });
  it("carrier cannot link another carrier's vehicle", async () => {
    const { data: v } = await service.from("carrier_vehicles")
      .insert({ carrier_id: carrierB.id, vehicle_type_id: (await service.from("vehicle_types").select("id").eq("code", "car").single()).data!.id, plate: plate("EE"), payload_kg: 1000 })
      .select("id").single();
    const { error } = await carrierA.client.from("carrier_documents").insert(
      doc(carrierA.id, "vehicle_registration", { vehicle_id: v!.id, expires_at: "2027-12-31" }),
    );
    expect(error).not.toBeNull();
  });
  it("carrier cannot self-approve or edit a document", async () => {
    const ins = await carrierA.client.from("carrier_documents").insert(
      doc(carrierA.id, "driving_license", { expires_at: "2027-12-31", review_status: "approved" }),
    );
    expect(ins.error).not.toBeNull();
    const upd = await carrierA.client.from("carrier_documents").update({ expires_at: "2099-01-01" }).eq("id", docId);
    expect(upd.error).not.toBeNull();
  });
  it("other carrier and customers cannot read it; admin can", async () => {
    for (const c of [carrierB.client, clienteA.client]) {
      const { data } = await c.from("carrier_documents").select("id").eq("id", docId);
      expect(data ?? []).toEqual([]);
    }
    const { data } = await admin.client.from("carrier_documents").select("id").eq("id", docId);
    expect(data).toHaveLength(1);
  });
});

describe("storage: carrier-documents bucket", () => {
  const pdf = new Blob(["%PDF-1.4 test"], { type: "application/pdf" });
  const bucket = "carrier-documents";

  it("carrier uploads to own folder", async () => {
    const { error } = await carrierA.client.storage.from(bucket).upload(`${carrierA.id}/rca.pdf`, pdf);
    expect(error).toBeNull();
  });
  it("carrier cannot upload into another carrier's folder", async () => {
    const { error } = await carrierA.client.storage.from(bucket).upload(`${carrierB.id}/fake.pdf`, pdf);
    expect(error).not.toBeNull();
  });
  it("carrier cannot overwrite or delete an uploaded document", async () => {
    const up = await carrierA.client.storage.from(bucket).upload(`${carrierA.id}/rca.pdf`, pdf, { upsert: true });
    expect(up.error).not.toBeNull();
    await carrierA.client.storage.from(bucket).remove([`${carrierA.id}/rca.pdf`]);
    const { data } = await service.storage.from(bucket).list(carrierA.id);
    expect(data?.map((f) => f.name)).toContain("rca.pdf");
  });
  it("other carrier, customer and anon cannot download it", async () => {
    for (const c of [carrierB.client, clienteA.client, anon]) {
      const { data } = await c.storage.from(bucket).download(`${carrierA.id}/rca.pdf`);
      expect(data).toBeNull();
    }
  });
  it("customer cannot upload documents", async () => {
    const { error } = await clienteA.client.storage.from(bucket).upload(`${clienteA.id}/x.pdf`, pdf);
    expect(error).not.toBeNull();
  });
  it("bucket is private (no public URL access)", async () => {
    const { data } = service.storage.from(bucket).getPublicUrl(`${carrierA.id}/rca.pdf`);
    const res = await fetch(data.publicUrl);
    expect(res.ok).toBe(false);
  });
  it("owner and admin can download", async () => {
    for (const c of [carrierA.client, admin.client]) {
      const { data, error } = await c.storage.from(bucket).download(`${carrierA.id}/rca.pdf`);
      expect(error).toBeNull();
      expect(data).not.toBeNull();
    }
  });
});

describe("settings", () => {
  it("exactly one row with the decided defaults", async () => {
    const { data } = await service.from("settings").select("*");
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      payout_window_hours: 24, gps_interval_s: 15, free_cancellation_hours: 24, late_cancellation_fee_bp: 5000,
    });
  });
  it("anon, customer and carrier cannot read or change settings", async () => {
    for (const c of [anon, clienteA.client, carrierA.client]) {
      const sel = await c.from("settings").select("id");
      expect(sel.data ?? []).toEqual([]);
      const upd = await c.from("settings").update({ payout_window_hours: 0 }).eq("id", true).select();
      expect(upd.data ?? []).toEqual([]);
    }
    const { data } = await service.from("settings").select("payout_window_hours").single();
    expect(data?.payout_window_hours).toBe(24);
  });
  it("a second settings row cannot be created", async () => {
    const { error } = await service.from("settings").insert({ id: false });
    expect(error).not.toBeNull();
  });
  it("admin reads and updates settings; updated_by is recorded", async () => {
    const { data, error } = await admin.client
      .from("settings").update({ company_name: "Transigo Srl (test)" }).eq("id", true).select("company_name, updated_by").single();
    expect(error).toBeNull();
    expect(data).toEqual({ company_name: "Transigo Srl (test)", updated_by: admin.id });
    await service.from("settings").update({ company_name: null }).eq("id", true);
  });
});

describe("audit_log", () => {
  it("nobody writes through the API, admin included", async () => {
    for (const c of [clienteA.client, carrierA.client, admin.client]) {
      const { error } = await c.from("audit_log").insert({ action: "test", entity_type: "test" });
      expect(error).not.toBeNull();
    }
  });
  it("only admin reads it", async () => {
    const { data: row } = await service.from("audit_log").insert({ action: "rls.test", entity_type: "test" }).select("id").single();
    const cust = await clienteA.client.from("audit_log").select("id").eq("id", row!.id);
    expect(cust.data ?? []).toEqual([]);
    const adm = await admin.client.from("audit_log").select("id").eq("id", row!.id);
    expect(adm.data).toHaveLength(1);
    await service.from("audit_log").delete().eq("id", row!.id);
  });
});
