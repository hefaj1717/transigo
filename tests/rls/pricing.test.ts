import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, createUser, deleteCreatedUsers, deleteUserNow, service, type TestUser } from "./helpers";

// Stage 2a security tests: price lists (admin only, drafts editable, published immutable),
// holidays, service area provinces, pricing settings. See docs/spec.md D59–D61.

let cliente: TestUser;
let carrier: TestUser;
let admin: TestUser;
let blockedAdmin: TestUser;

let activeId: string;
const createdDrafts: string[] = [];

async function activeList() {
  const { data, error } = await service.from("price_lists").select("id, version").eq("status", "active").single();
  if (error) throw error;
  return data;
}

async function cloneActiveAsAdmin() {
  const { data, error } = await admin.client.rpc("clone_price_list", { p_source_id: activeId });
  if (error) throw error;
  createdDrafts.push(data as string);
  return data as string;
}

beforeAll(async () => {
  cliente = await createUser({});
  carrier = await createUser({ role: "padroncino" });
  admin = await createUser({});
  blockedAdmin = await createUser({});
  const setup = await Promise.all([
    service.from("profiles").update({ role: "admin" }).eq("id", admin.id),
    service.from("profiles").update({ role: "admin", is_blocked: true }).eq("id", blockedAdmin.id),
  ]);
  for (const r of setup) if (r.error) throw r.error;
  activeId = (await activeList()).id;
});

afterAll(async () => {
  // Local database only (D64), reset before every run — just drop the test drafts.
  if (createdDrafts.length) {
    await service.from("price_lists").delete().in("id", createdDrafts).eq("status", "draft");
  }
  await deleteCreatedUsers();
});

describe("price tables are admin-only (D59)", () => {
  for (const table of ["price_lists", "price_list_vehicle_rates", "price_rules", "price_list_porter_packages", "price_list_storage_boxes"]) {
    it(`anon, cliente, padroncino and a blocked admin read nothing from ${table}`, async () => {
      for (const client of [anon, cliente.client, carrier.client, blockedAdmin.client]) {
        const { data } = await client.from(table).select("*");
        expect(data ?? []).toEqual([]);
      }
    });
  }

  it("admin reads the active list with rates for every active vehicle type and all rules", async () => {
    const { data: rates } = await admin.client.from("price_list_vehicle_rates").select("vehicle_type_id").eq("price_list_id", activeId);
    const { data: types } = await service.from("vehicle_types").select("id").eq("is_active", true);
    // Every active type has a rate; the list may also keep rates of types turned off later (D183: car).
    const rated = new Set(rates?.map((r) => r.vehicle_type_id));
    expect(types?.length).toBeGreaterThan(0);
    expect(types?.every((t) => rated.has(t.id))).toBe(true);
    const { data: rules } = await admin.client.from("price_rules").select("code").eq("price_list_id", activeId);
    // Every rule of the active list (the active version depends on earlier test files, e.g. orders.test.ts publishes one).
    const { count: allRules } = await service.from("price_rules").select("code", { count: "exact", head: true }).eq("price_list_id", activeId);
    expect(allRules).toBeGreaterThanOrEqual(14);
    expect(rules?.length).toBe(allRules);
  });

  it("non-admins cannot clone or publish", async () => {
    for (const client of [cliente.client, carrier.client, blockedAdmin.client]) {
      const clone = await client.rpc("clone_price_list", { p_source_id: activeId });
      expect(clone.error).not.toBeNull();
    }
    const anonClone = await anon.rpc("clone_price_list", { p_source_id: activeId });
    expect(anonClone.error).not.toBeNull();
  });

  it("non-admins cannot change rules of a draft", async () => {
    const draftId = await cloneActiveAsAdmin();
    const { data } = await cliente.client
      .from("price_rules")
      .update({ percent_bp: 0 })
      .eq("price_list_id", draftId)
      .eq("code", "carrier_share_transport")
      .select();
    expect(data ?? []).toEqual([]);
    const { data: rule } = await service.from("price_rules").select("percent_bp").eq("price_list_id", draftId).eq("code", "carrier_share_transport").single();
    expect(rule?.percent_bp).toBe(7000);
  });
});

describe("price list versioning (D60)", () => {
  it("admin clones the active list into a new draft with copied rates and rules", async () => {
    const draftId = await cloneActiveAsAdmin();
    const { data: draft } = await admin.client.from("price_lists").select("status, version").eq("id", draftId).single();
    expect(draft?.status).toBe("draft");
    const { count: rates } = await admin.client.from("price_list_vehicle_rates").select("*", { count: "exact", head: true }).eq("price_list_id", draftId);
    const { count: rules } = await admin.client.from("price_rules").select("*", { count: "exact", head: true }).eq("price_list_id", draftId);
    expect(rates).toBeGreaterThan(0);
    expect(rules).toBe(16); // the 14 seeded rules + porter_overtime_hour (D68) and porters_floor_no_elevator (D157) filled in by the clone
  });

  it("admin edits a draft (list fields, rates, rules)", async () => {
    const draftId = await cloneActiveAsAdmin();
    const a = await admin.client.from("price_lists").update({ urgent_lead_hours: 12 }).eq("id", draftId).select();
    expect(a.error).toBeNull();
    expect(a.data?.length).toBe(1);
    const b = await admin.client.from("price_list_vehicle_rates").update({ rate_per_km_cents: 999 }).eq("price_list_id", draftId).select();
    expect(b.error).toBeNull();
    expect(b.data?.length).toBeGreaterThan(0);
    const c = await admin.client.from("price_rules").update({ amount_cents: 1234 }).eq("price_list_id", draftId).eq("code", "porter_hour").select();
    expect(c.error).toBeNull();
    expect(c.data?.length).toBe(1);
  });

  it("admin cannot change status or version directly", async () => {
    const draftId = await cloneActiveAsAdmin();
    for (const patch of [{ status: "active" }, { version: 999 }, { published_at: new Date().toISOString() }]) {
      const { error } = await admin.client.from("price_lists").update(patch).eq("id", draftId);
      expect(error, JSON.stringify(patch)).not.toBeNull();
    }
  });

  it("the active list, its rates and rules are read-only for admin and service role", async () => {
    const r1 = await admin.client.from("price_lists").update({ notes: "x" }).eq("id", activeId);
    expect(r1.error).not.toBeNull();
    const r2 = await admin.client.from("price_list_vehicle_rates").update({ rate_per_km_cents: 1 }).eq("price_list_id", activeId);
    expect(r2.error).not.toBeNull();
    const r3 = await admin.client.from("price_rules").update({ is_enabled: false }).eq("price_list_id", activeId).eq("code", "porter_hour");
    expect(r3.error).not.toBeNull();
    const r4 = await service.from("price_rules").update({ amount_cents: 1 }).eq("price_list_id", activeId).eq("code", "porter_hour");
    expect(r4.error).not.toBeNull();
    const r5 = await admin.client.from("price_lists").delete().eq("id", activeId);
    expect(r5.error).not.toBeNull();
    expect((await activeList()).id).toBe(activeId);
  });

  it("rule checks reject a kind that does not match the code or the value columns", async () => {
    const draftId = await cloneActiveAsAdmin();
    const bad = [
      { kind: "percent", amount_cents: null, percent_bp: 1000, code: "porter_hour" }, // porters must be per_unit
      { kind: "percent", amount_cents: 100, percent_bp: null, code: "surcharge_urgent" }, // percent without percent_bp
      { kind: "percent", amount_cents: null, percent_bp: 12000, code: "carrier_share_transport" }, // > 100 %
    ];
    for (const { code, ...patch } of bad) {
      const { error } = await admin.client.from("price_rules").update(patch).eq("price_list_id", draftId).eq("code", code);
      expect(error, code).not.toBeNull();
    }
  });

  it("publishing an incomplete draft fails and leaves the active list untouched", async () => {
    const draftId = await cloneActiveAsAdmin();
    await admin.client.from("price_rules").delete().eq("price_list_id", draftId).eq("code", "packing_flat");
    const { error } = await admin.client.rpc("publish_price_list", { p_price_list_id: draftId });
    expect(error?.message).toMatch(/missing/);
    expect((await activeList()).id).toBe(activeId);
  });

  it("publishing archives the previous list and keeps exactly one active (then restores)", async () => {
    const draftId = await cloneActiveAsAdmin();
    const { error } = await admin.client.rpc("publish_price_list", { p_price_list_id: draftId });
    expect(error).toBeNull();
    const { data: lists } = await service.from("price_lists").select("id, status").in("id", [activeId, draftId]);
    expect(Object.fromEntries((lists ?? []).map((l) => [l.id, l.status]))).toEqual({ [activeId]: "archived", [draftId]: "active" });
    const { count } = await service.from("price_lists").select("*", { count: "exact", head: true }).eq("status", "active");
    expect(count).toBe(1);

    // archived → active is not allowed, even for the service role
    const back = await service.from("price_lists").update({ status: "active" }).eq("id", activeId);
    expect(back.error).not.toBeNull();

    // Restore: clone the original (archived) list and publish the clone. Its content equals the original.
    const { data: restoredId, error: cloneErr } = await admin.client.rpc("clone_price_list", { p_source_id: activeId });
    expect(cloneErr).toBeNull();
    const pub = await admin.client.rpc("publish_price_list", { p_price_list_id: restoredId });
    expect(pub.error).toBeNull();
    activeId = restoredId as string;
  });
});

describe("deleting the publisher's account", () => {
  it("succeeds and only clears published_by; the published list stays unchanged", async () => {
    const publisher = await createUser({});
    await service.from("profiles").update({ role: "admin" }).eq("id", publisher.id);
    const { data: draftId, error: cloneErr } = await publisher.client.rpc("clone_price_list", { p_source_id: activeId });
    expect(cloneErr).toBeNull();
    const pub = await publisher.client.rpc("publish_price_list", { p_price_list_id: draftId });
    expect(pub.error).toBeNull();
    activeId = draftId as string;

    const before = await service.from("price_lists").select("version, status, vat_rate_bp, published_at, published_by").eq("id", activeId).single();
    expect(before.data?.published_by).toBe(publisher.id);
    const rulesBefore = await service.from("price_rules").select("*").eq("price_list_id", activeId).order("code");

    await deleteUserNow(publisher); // used to fail with "Price list status cannot change from active to active"

    const after = await service.from("price_lists").select("version, status, vat_rate_bp, published_at, published_by").eq("id", activeId).single();
    expect(after.data).toEqual({ ...before.data, published_by: null });
    const rulesAfter = await service.from("price_rules").select("*").eq("price_list_id", activeId).order("code");
    expect(rulesAfter.data).toEqual(rulesBefore.data);
  });

  it("clearing published_by does not open other edits of a published list", async () => {
    const r = await service.from("price_lists").update({ published_by: null, notes: "changed" }).eq("id", activeId);
    expect(r.error).not.toBeNull();
  });
});

describe("porter packages and overtime (D67, D68)", () => {
  const packagesOf = async (listId: string) =>
    (await admin.client.from("price_list_porter_packages").select("code, porters_count, included_hours, is_enabled").eq("price_list_id", listId).order("code")).data;

  it("the seeded v1 has no packages; its clone gets the placeholder packages, overtime rule and grace", async () => {
    const { data: v1 } = await service.from("price_lists").select("id").eq("version", 1).single();
    expect(await packagesOf(v1!.id)).toEqual([]);
    const draftId = (await admin.client.rpc("clone_price_list", { p_source_id: v1!.id })).data as string;
    createdDrafts.push(draftId);
    expect(await packagesOf(draftId)).toEqual([
      { code: "parcels", porters_count: 1, included_hours: 1, is_enabled: true },
      { code: "monolocale", porters_count: 2, included_hours: 2, is_enabled: true },
      { code: "bilocale", porters_count: 2, included_hours: 3, is_enabled: true },
      { code: "trilocale_plus", porters_count: 3, included_hours: 4, is_enabled: true },
    ]);
    const { data: rule } = await admin.client.from("price_rules").select("kind, amount_cents, is_enabled").eq("price_list_id", draftId).eq("code", "porter_overtime_hour").single();
    expect(rule).toEqual({ kind: "per_unit", amount_cents: 3500, is_enabled: true });
    const { data: list } = await admin.client.from("price_lists").select("porter_overtime_grace_minutes").eq("id", draftId).single();
    expect(list?.porter_overtime_grace_minutes).toBe(15);
  });

  it("admin edits packages, overtime rule and grace of a draft; a clone copies the edited values", async () => {
    const draftId = await cloneActiveAsAdmin();
    const a = await admin.client.from("price_list_porter_packages").update({ porters_count: 3, included_hours: 5, is_enabled: false }).eq("price_list_id", draftId).eq("code", "bilocale").select();
    expect(a.error).toBeNull();
    expect(a.data?.length).toBe(1);
    const b = await admin.client.from("price_rules").update({ amount_cents: 4000, is_enabled: false }).eq("price_list_id", draftId).eq("code", "porter_overtime_hour").select();
    expect(b.data?.length).toBe(1);
    const c = await admin.client.from("price_lists").update({ porter_overtime_grace_minutes: 10 }).eq("id", draftId).select();
    expect(c.data?.length).toBe(1);

    const copyId = (await admin.client.rpc("clone_price_list", { p_source_id: draftId })).data as string;
    createdDrafts.push(copyId);
    expect((await packagesOf(copyId))?.find((p) => p.code === "bilocale")).toEqual({ code: "bilocale", porters_count: 3, included_hours: 5, is_enabled: false });
    const { data: rule } = await admin.client.from("price_rules").select("amount_cents, is_enabled").eq("price_list_id", copyId).eq("code", "porter_overtime_hour").single();
    expect(rule).toEqual({ amount_cents: 4000, is_enabled: false });
    const { data: list } = await admin.client.from("price_lists").select("porter_overtime_grace_minutes").eq("id", copyId).single();
    expect(list?.porter_overtime_grace_minutes).toBe(10);
  });

  it("non-admins cannot change or add packages of a draft", async () => {
    const draftId = await cloneActiveAsAdmin();
    for (const client of [cliente.client, carrier.client, blockedAdmin.client, anon]) {
      const { data } = await client.from("price_list_porter_packages").update({ included_hours: 8 }).eq("price_list_id", draftId).select();
      expect(data ?? []).toEqual([]);
      const ins = await client.from("price_list_porter_packages").insert({ price_list_id: draftId, code: "parcels", porters_count: 1, included_hours: 1 });
      expect(ins.error).not.toBeNull();
    }
    expect((await packagesOf(draftId))?.every((p) => p.included_hours !== 8)).toBe(true);
  });

  it("packages and grace of the published list are read-only for admin and service role", async () => {
    expect((await packagesOf(activeId))?.length).toBe(4); // the active list is a clone published above
    const r1 = await admin.client.from("price_list_porter_packages").update({ included_hours: 8 }).eq("price_list_id", activeId).eq("code", "parcels");
    expect(r1.error).not.toBeNull();
    const r2 = await service.from("price_list_porter_packages").update({ included_hours: 8 }).eq("price_list_id", activeId).eq("code", "parcels");
    expect(r2.error).not.toBeNull();
    const r3 = await service.from("price_list_porter_packages").delete().eq("price_list_id", activeId).eq("code", "parcels");
    expect(r3.error).not.toBeNull();
    const r4 = await admin.client.from("price_lists").update({ porter_overtime_grace_minutes: 30 }).eq("id", activeId);
    expect(r4.error).not.toBeNull();
  });

  it("checks reject persons outside 1–4, hours outside 1–8, grace outside 0–120 and a non per_unit overtime rule", async () => {
    const draftId = await cloneActiveAsAdmin();
    for (const patch of [{ porters_count: 0 }, { porters_count: 5 }, { included_hours: 0 }, { included_hours: 9 }]) {
      const { error } = await admin.client.from("price_list_porter_packages").update(patch).eq("price_list_id", draftId).eq("code", "parcels");
      expect(error, JSON.stringify(patch)).not.toBeNull();
    }
    for (const grace of [-1, 121]) {
      const { error } = await admin.client.from("price_lists").update({ porter_overtime_grace_minutes: grace }).eq("id", draftId);
      expect(error, String(grace)).not.toBeNull();
    }
    const { error } = await admin.client.from("price_rules").update({ kind: "percent", amount_cents: null, percent_bp: 1000 }).eq("price_list_id", draftId).eq("code", "porter_overtime_hour");
    expect(error).not.toBeNull();
  });

  it("publishing a draft without all four packages or without the overtime rule fails", async () => {
    const noPackage = await cloneActiveAsAdmin();
    await admin.client.from("price_list_porter_packages").delete().eq("price_list_id", noPackage).eq("code", "trilocale_plus");
    const a = await admin.client.rpc("publish_price_list", { p_price_list_id: noPackage });
    expect(a.error?.message).toMatch(/missing 1 porter package/);

    const noRule = await cloneActiveAsAdmin();
    await admin.client.from("price_rules").delete().eq("price_list_id", noRule).eq("code", "porter_overtime_hour");
    const b = await admin.client.rpc("publish_price_list", { p_price_list_id: noRule });
    expect(b.error?.message).toMatch(/missing 1 pricing rule/);
    expect((await activeList()).id).toBe(activeId);
  });

  it("fill_porter_defaults is not callable through the API", async () => {
    const draftId = await cloneActiveAsAdmin();
    for (const client of [admin.client, cliente.client, anon]) {
      const { error } = await client.rpc("fill_porter_defaults", { p_price_list_id: draftId });
      expect(error).not.toBeNull();
    }
  });
});

describe("porters-only service and storage boxes (D154, D157)", () => {
  const boxesOf = async (listId: string) =>
    (await admin.client.from("price_list_storage_boxes").select("code, label_it, volume_m3, day_cents, month_cents, sort_order, is_enabled").eq("price_list_id", listId).order("sort_order")).data;
  const newBox = (listId: string, code = "xl") => ({ price_list_id: listId, code, label_it: "Box XL", volume_m3: 15, day_cents: 1000, month_cents: 20000, sort_order: 4 });

  it("the seeded v1 has no boxes nor floor rule; its clone gets the placeholders and minimums 2 h / 2 persons", async () => {
    const { data: v1 } = await service.from("price_lists").select("id, porters_min_hours, porters_min_persons").eq("version", 1).single();
    expect(await boxesOf(v1!.id)).toEqual([]);
    const { data: v1Rule } = await service.from("price_rules").select("code").eq("price_list_id", v1!.id).eq("code", "porters_floor_no_elevator");
    expect(v1Rule).toEqual([]);
    const draftId = (await admin.client.rpc("clone_price_list", { p_source_id: v1!.id })).data as string;
    createdDrafts.push(draftId);
    expect(await boxesOf(draftId)).toEqual([
      { code: "s", label_it: "Box S", volume_m3: 3, day_cents: 300, month_cents: 6000, sort_order: 1, is_enabled: true },
      { code: "m", label_it: "Box M", volume_m3: 6, day_cents: 500, month_cents: 10000, sort_order: 2, is_enabled: true },
      { code: "l", label_it: "Box L", volume_m3: 10, day_cents: 800, month_cents: 15000, sort_order: 3, is_enabled: true },
    ]);
    const { data: rule } = await admin.client.from("price_rules").select("kind, amount_cents, is_enabled").eq("price_list_id", draftId).eq("code", "porters_floor_no_elevator").single();
    expect(rule).toEqual({ kind: "per_unit", amount_cents: 1000, is_enabled: true });
    const { data: list } = await admin.client.from("price_lists").select("porters_min_hours, porters_min_persons").eq("id", draftId).single();
    expect(list).toEqual({ porters_min_hours: 2, porters_min_persons: 2 });
  });

  it("admin edits, disables and adds boxes and minimums of a draft; a clone copies them and does not re-add placeholders", async () => {
    const draftId = await cloneActiveAsAdmin();
    const a = await admin.client.from("price_list_storage_boxes").update({ label_it: "Box piccolo", volume_m3: 3.5, day_cents: 350, month_cents: 7000, sort_order: 5, is_enabled: false }).eq("price_list_id", draftId).eq("code", "s").select();
    expect(a.error).toBeNull();
    expect(a.data?.length).toBe(1);
    const b = await admin.client.from("price_list_storage_boxes").insert(newBox(draftId));
    expect(b.error).toBeNull();
    const c = await admin.client.from("price_list_storage_boxes").delete().eq("price_list_id", draftId).eq("code", "m").select();
    expect(c.data?.length).toBe(1);
    const d = await admin.client.from("price_lists").update({ porters_min_hours: 3, porters_min_persons: 3 }).eq("id", draftId).select();
    expect(d.data?.length).toBe(1);
    const e = await admin.client.from("price_rules").update({ amount_cents: 1500, is_enabled: false }).eq("price_list_id", draftId).eq("code", "porters_floor_no_elevator").select();
    expect(e.data?.length).toBe(1);

    const copyId = (await admin.client.rpc("clone_price_list", { p_source_id: draftId })).data as string;
    createdDrafts.push(copyId);
    expect(await boxesOf(copyId)).toEqual([
      { code: "l", label_it: "Box L", volume_m3: 10, day_cents: 800, month_cents: 15000, sort_order: 3, is_enabled: true },
      { code: "xl", label_it: "Box XL", volume_m3: 15, day_cents: 1000, month_cents: 20000, sort_order: 4, is_enabled: true },
      { code: "s", label_it: "Box piccolo", volume_m3: 3.5, day_cents: 350, month_cents: 7000, sort_order: 5, is_enabled: false },
    ]);
    const { data: list } = await admin.client.from("price_lists").select("porters_min_hours, porters_min_persons").eq("id", copyId).single();
    expect(list).toEqual({ porters_min_hours: 3, porters_min_persons: 3 });
    const { data: rule } = await admin.client.from("price_rules").select("amount_cents, is_enabled").eq("price_list_id", copyId).eq("code", "porters_floor_no_elevator").single();
    expect(rule).toEqual({ amount_cents: 1500, is_enabled: false });
  });

  it("the box code cannot be changed, even by admin", async () => {
    const draftId = await cloneActiveAsAdmin();
    const { error } = await admin.client.from("price_list_storage_boxes").update({ code: "zz" }).eq("price_list_id", draftId).eq("code", "s");
    expect(error).not.toBeNull();
  });

  it("non-admins cannot read, change, add or delete boxes of a draft, nor change the minimums", async () => {
    const draftId = await cloneActiveAsAdmin();
    for (const client of [cliente.client, carrier.client, blockedAdmin.client, anon]) {
      const read = await client.from("price_list_storage_boxes").select("code").eq("price_list_id", draftId);
      expect(read.data ?? []).toEqual([]);
      const upd = await client.from("price_list_storage_boxes").update({ day_cents: 1 }).eq("price_list_id", draftId).select();
      expect(upd.data ?? []).toEqual([]);
      const ins = await client.from("price_list_storage_boxes").insert(newBox(draftId, "hack"));
      expect(ins.error).not.toBeNull();
      const del = await client.from("price_list_storage_boxes").delete().eq("price_list_id", draftId).select();
      expect(del.data ?? []).toEqual([]);
      const min = await client.from("price_lists").update({ porters_min_hours: 9 }).eq("id", draftId).select();
      expect(min.data ?? []).toEqual([]);
    }
    expect((await boxesOf(draftId))?.map((b) => [b.code, b.day_cents])).toEqual([["s", 300], ["m", 500], ["l", 800]]);
    const { data: list } = await service.from("price_lists").select("porters_min_hours").eq("id", draftId).single();
    expect(list?.porters_min_hours).toBe(2);
  });

  it("boxes, minimums and floor rule of the published list are read-only for admin and service role", async () => {
    expect((await boxesOf(activeId))?.length).toBe(3); // the active list is a clone published above
    for (const client of [admin.client, service]) {
      const r1 = await client.from("price_list_storage_boxes").update({ day_cents: 1 }).eq("price_list_id", activeId).eq("code", "s");
      expect(r1.error).not.toBeNull();
      const r2 = await client.from("price_list_storage_boxes").delete().eq("price_list_id", activeId).eq("code", "s");
      expect(r2.error).not.toBeNull();
      const r3 = await client.from("price_list_storage_boxes").insert(newBox(activeId));
      expect(r3.error).not.toBeNull();
      const r4 = await client.from("price_lists").update({ porters_min_hours: 5 }).eq("id", activeId);
      expect(r4.error).not.toBeNull();
      const r5 = await client.from("price_rules").update({ amount_cents: 1 }).eq("price_list_id", activeId).eq("code", "porters_floor_no_elevator");
      expect(r5.error).not.toBeNull();
    }
    expect((await boxesOf(activeId))?.find((b) => b.code === "s")?.day_cents).toBe(300);
  });

  it("checks reject bad box values, minimums outside range and a non per_unit floor rule", async () => {
    const draftId = await cloneActiveAsAdmin();
    for (const patch of [{ day_cents: 0 }, { month_cents: 0 }, { volume_m3: 0 }, { volume_m3: 101 }, { label_it: " " }, { sort_order: 1000 }]) {
      const { error } = await admin.client.from("price_list_storage_boxes").update(patch).eq("price_list_id", draftId).eq("code", "s");
      expect(error, JSON.stringify(patch)).not.toBeNull();
    }
    for (const code of ["XL", "a b", "", "x".repeat(21)]) {
      const { error } = await admin.client.from("price_list_storage_boxes").insert(newBox(draftId, code));
      expect(error, code).not.toBeNull();
    }
    for (const patch of [{ porters_min_hours: 0 }, { porters_min_hours: 13 }, { porters_min_persons: 0 }, { porters_min_persons: 5 }]) {
      const { error } = await admin.client.from("price_lists").update(patch).eq("id", draftId);
      expect(error, JSON.stringify(patch)).not.toBeNull();
    }
    // D177: one person is a valid minimum
    const one = await admin.client.from("price_lists").update({ porters_min_persons: 1 }).eq("id", draftId).select("porters_min_persons");
    expect(one.error).toBeNull();
    expect(one.data).toEqual([{ porters_min_persons: 1 }]);
    const { error } = await admin.client.from("price_rules").update({ kind: "fixed" }).eq("price_list_id", draftId).eq("code", "porters_floor_no_elevator");
    expect(error).not.toBeNull();
  });

  it("publishing a draft without the floor rule fails; without boxes it succeeds (boxes are optional)", async () => {
    const noRule = await cloneActiveAsAdmin();
    await admin.client.from("price_rules").delete().eq("price_list_id", noRule).eq("code", "porters_floor_no_elevator");
    const a = await admin.client.rpc("publish_price_list", { p_price_list_id: noRule });
    expect(a.error?.message).toMatch(/missing 1 pricing rule/);
    expect((await activeList()).id).toBe(activeId);

    const noBoxes = await cloneActiveAsAdmin();
    await admin.client.from("price_list_storage_boxes").delete().eq("price_list_id", noBoxes);
    const b = await admin.client.rpc("publish_price_list", { p_price_list_id: noBoxes });
    expect(b.error).toBeNull();
    // Restore the previous content (with boxes) as the active list for later tests.
    const restoredId = (await admin.client.rpc("clone_price_list", { p_source_id: activeId })).data as string;
    expect((await admin.client.rpc("publish_price_list", { p_price_list_id: restoredId })).error).toBeNull();
    activeId = restoredId;
    expect((await boxesOf(activeId))?.length).toBe(3);
  });

  it("fill_service_defaults is not callable through the API", async () => {
    const draftId = await cloneActiveAsAdmin();
    for (const client of [admin.client, cliente.client, anon]) {
      const { error } = await client.rpc("fill_service_defaults", { p_price_list_id: draftId });
      expect(error).not.toBeNull();
    }
  });
});

describe("holidays", () => {
  it("anon reads holidays", async () => {
    const { data } = await anon.from("holidays").select("date, name_it").eq("date", "2026-06-02").single();
    expect(data?.name_it).toBe("Festa della Repubblica");
  });
  it("non-admins cannot add holidays", async () => {
    for (const client of [anon, cliente.client, carrier.client]) {
      const { error } = await client.from("holidays").insert({ date: "2030-01-02", name_it: "Test" });
      expect(error).not.toBeNull();
    }
  });
  it("admin adds and removes a holiday", async () => {
    const ins = await admin.client.from("holidays").insert({ date: "2030-01-02", name_it: "Test" });
    expect(ins.error).toBeNull();
    const del = await admin.client.from("holidays").delete().eq("date", "2030-01-02").select();
    expect(del.data?.length).toBe(1);
  });
});

describe("service area provinces", () => {
  it("anon sees only active provinces", async () => {
    const { data: all } = await service.from("service_area_provinces").select("province_code, is_active");
    expect(all?.length).toBe(107);
    const { data } = await anon.from("service_area_provinces").select("province_code, is_active");
    expect((data ?? []).every((p) => p.is_active)).toBe(true);
    expect(data?.length).toBe((all ?? []).filter((p) => p.is_active).length);
  });
  it("non-admins cannot activate a province", async () => {
    const { data } = await cliente.client.from("service_area_provinces").update({ is_active: true }).eq("province_code", "AO").select();
    expect(data ?? []).toEqual([]);
    const { data: row } = await service.from("service_area_provinces").select("is_active").eq("province_code", "AO").single();
    expect(row?.is_active).toBe(false);
  });
  it("admin activates and deactivates a province", async () => {
    const on = await admin.client.from("service_area_provinces").update({ is_active: true }).eq("province_code", "AO").select();
    expect(on.data?.length).toBe(1);
    const off = await admin.client.from("service_area_provinces").update({ is_active: false }).eq("province_code", "AO").select();
    expect(off.data?.[0]?.is_active).toBe(false);
  });
});

describe("pricing settings", () => {
  it("only admin reads and changes max_route_distance_m", async () => {
    const { data: none } = await cliente.client.from("settings").select("max_route_distance_m");
    expect(none ?? []).toEqual([]);
    const { data: before } = await admin.client.from("settings").select("max_route_distance_m, min_booking_lead_hours, quote_valid_minutes").single();
    expect(before).toEqual({ max_route_distance_m: 300000, min_booking_lead_hours: 3, quote_valid_minutes: 30 });
    const upd = await admin.client.from("settings").update({ max_route_distance_m: 250000 }).eq("id", true).select("max_route_distance_m");
    expect(upd.data?.[0]?.max_route_distance_m).toBe(250000);
    await admin.client.from("settings").update({ max_route_distance_m: 300000 }).eq("id", true);
  });
});
