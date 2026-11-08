import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";

// Migration 20261108152359_consents: legal consents (D42), private customer without codice fiscale (D43),
// business customer needs SDI or PEC (D44).

let cliente: TestUser;
let carrier: TestUser;
let admin: TestUser;

const vat = () => `${Math.floor(Math.random() * 1e11).toString().padStart(11, "0")}`;

beforeAll(async () => {
  cliente = await createUser({});
  carrier = await createUser({ role: "padroncino" });
  admin = await createUser({});
  const { error } = await service.from("profiles").update({ role: "admin" }).eq("id", admin.id);
  if (error) throw error;
});

afterAll(async () => {
  await deleteCreatedUsers();
});

describe("profiles: consent columns", () => {
  it("server records both consents with versions", async () => {
    const now = new Date().toISOString();
    const { error } = await service.from("profiles").update({
      terms_accepted_at: now, terms_version: "2026-11-01",
      privacy_accepted_at: now, privacy_version: "2026-11-01",
    }).eq("id", cliente.id);
    expect(error).toBeNull();
  });
  it("user reads own consents", async () => {
    const { data } = await cliente.client.from("profiles").select("terms_version, privacy_version").single();
    expect(data).toEqual({ terms_version: "2026-11-01", privacy_version: "2026-11-01" });
  });
  it("user cannot change or withdraw consents directly", async () => {
    for (const patch of [
      { terms_version: "1999-01-01" },
      { terms_accepted_at: null, terms_version: null },
      { privacy_accepted_at: new Date().toISOString() },
      { privacy_version: "x" },
    ]) {
      const { error } = await cliente.client.from("profiles").update(patch).eq("id", cliente.id);
      expect(error, JSON.stringify(patch)).not.toBeNull();
    }
  });
  it("timestamp without version (and vice versa) is rejected", async () => {
    const a = await service.from("profiles").update({ terms_accepted_at: new Date().toISOString(), terms_version: null }).eq("id", carrier.id);
    const b = await service.from("profiles").update({ privacy_accepted_at: null, privacy_version: "2026-11-01" }).eq("id", carrier.id);
    expect(a.error).not.toBeNull();
    expect(b.error).not.toBeNull();
  });
});

describe("settings: legal document versions", () => {
  it("defaults to 2026-11-01", async () => {
    const { data } = await service.from("settings").select("terms_version, privacy_version").single();
    expect(data).toEqual({ terms_version: "2026-11-01", privacy_version: "2026-11-01" });
  });
  it("customer, carrier and anon cannot read or change versions", async () => {
    for (const c of [anon, cliente.client, carrier.client]) {
      const sel = await c.from("settings").select("terms_version");
      expect(sel.data ?? []).toEqual([]);
      const upd = await c.from("settings").update({ terms_version: "hack" }).eq("id", true).select();
      expect(upd.data ?? []).toEqual([]);
    }
  });
  it("admin can update versions; empty version is rejected", async () => {
    const ok = await admin.client.from("settings").update({ privacy_version: "2026-12-01" }).eq("id", true).select("privacy_version").single();
    expect(ok.error).toBeNull();
    expect(ok.data).toEqual({ privacy_version: "2026-12-01" });
    const bad = await admin.client.from("settings").update({ privacy_version: " " }).eq("id", true);
    expect(bad.error).not.toBeNull();
    await service.from("settings").update({ privacy_version: "2026-11-01" }).eq("id", true);
  });
});

describe("customers: registration rules", () => {
  it("private customer can be created without codice fiscale (D43)", async () => {
    const { error } = await service.from("customers").insert({ profile_id: cliente.id, customer_type: "private" });
    expect(error).toBeNull();
    await service.from("customers").delete().eq("profile_id", cliente.id);
  });
  it("business customer without SDI and PEC is rejected (D44)", async () => {
    const { error } = await service.from("customers").insert({
      profile_id: cliente.id, customer_type: "business", company_name: "Gamma Srl", vat_number: vat(),
    });
    expect(error).not.toBeNull();
  });
  it("business customer with SDI or with PEC is accepted", async () => {
    const sdi = await service.from("customers").insert({
      profile_id: cliente.id, customer_type: "business", company_name: "Gamma Srl", vat_number: vat(), sdi_code: "M5UXCR1",
    });
    expect(sdi.error).toBeNull();
    // the customer cannot remove the last e-invoicing channel either
    const strip = await cliente.client.from("customers").update({ sdi_code: null }).eq("profile_id", cliente.id);
    expect(strip.error).not.toBeNull();
    await service.from("customers").delete().eq("profile_id", cliente.id);

    const pec = await service.from("customers").insert({
      profile_id: cliente.id, customer_type: "business", company_name: "Gamma Srl", vat_number: vat(), pec: "gamma@pec.it",
    });
    expect(pec.error).toBeNull();
  });
});
