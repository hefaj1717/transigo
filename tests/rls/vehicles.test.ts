import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";

// Vehicle recommendation data (D81, D83, D86): capacities are public like vehicle_types, the category
// minimums are admin-only, and create_order stores the goods snapshot.

let cliente: TestUser;
let carrier: TestUser;
let admin: TestUser;
let blockedAdmin: TestUser;
const createdOrders: string[] = [];

const check = async (p: PromiseLike<{ error: unknown }>) => {
  const { error } = await p;
  if (error) throw error;
};

beforeAll(async () => {
  [cliente, carrier, admin, blockedAdmin] = await Promise.all([createUser({}), createUser({ role: "padroncino" }), createUser({}), createUser({})]);
  await check(service.from("customers").insert({ profile_id: cliente.id, customer_type: "private" }));
  await check(service.from("profiles").update({ role: "admin" }).in("id", [admin.id, blockedAdmin.id]));
  await check(service.from("profiles").update({ is_blocked: true }).eq("id", blockedAdmin.id));
});

afterAll(async () => {
  if (createdOrders.length) await check(service.from("orders").delete().in("id", createdOrders));
  await deleteCreatedUsers();
});

describe("vehicle capacities (D81)", () => {
  it("D183: car is turned off, not deleted — anon sees only the three vans and the truck", async () => {
    const { data } = await anon.from("vehicle_types").select("code").order("size_rank");
    expect(data?.map((v) => v.code)).toEqual(["van_small", "van_medium", "van_large", "truck_tail_lift"]);
    const { data: car } = await service.from("vehicle_types").select("is_active").eq("code", "car").single();
    expect(car).toEqual({ is_active: false });
  });

  it("placeholders are set (anon reads the active ones, see D183 test)", async () => {
    const { data } = await service.from("vehicle_types").select("code, payload_kg, cargo_length_cm, cargo_width_cm, cargo_height_cm, euro_pallets").order("size_rank");
    expect(data?.map((v) => [v.code, v.payload_kg, v.euro_pallets])).toEqual([
      ["car", 400, 0],
      ["van_small", 750, 2],
      ["van_medium", 1200, 4],
      ["van_large", 1000, 8],
      ["truck_tail_lift", 3000, 15],
    ]);
    expect(data?.every((v) => v.cargo_length_cm && v.cargo_width_cm && v.cargo_height_cm)).toBe(true);
  });

  it("only admin changes euro_pallets; negative values are rejected", async () => {
    const { data: car } = await service.from("vehicle_types").select("id").eq("code", "car").single();
    const r1 = await cliente.client.from("vehicle_types").update({ euro_pallets: 9 }).eq("id", car!.id).select();
    expect(r1.data ?? []).toEqual([]);
    expect((await admin.client.from("vehicle_types").update({ euro_pallets: -1 }).eq("id", car!.id)).error).not.toBeNull();
    const r2 = await admin.client.from("vehicle_types").update({ euro_pallets: 1 }).eq("id", car!.id).select("euro_pallets");
    expect(r2.data).toEqual([{ euro_pallets: 1 }]);
    await check(service.from("vehicle_types").update({ euro_pallets: 0 }).eq("id", car!.id));
  });
});

describe("porter_package_min_vehicle (D83) — admin only", () => {
  it("placeholders: monolocale → van_medium, bilocale and trilocale_plus → van_large, parcels none", async () => {
    const { data } = await service.from("porter_package_min_vehicle").select("package_code, vehicle_types(code)").order("package_code");
    const map = Object.fromEntries((data ?? []).map((r) => [r.package_code, (r.vehicle_types as unknown as { code: string }).code]));
    expect(map).toEqual({ monolocale: "van_medium", bilocale: "van_large", trilocale_plus: "van_large" });
  });

  it("anon, cliente, padroncino and a blocked admin read and write nothing", async () => {
    const { data: vt } = await service.from("vehicle_types").select("id").eq("code", "car").single();
    for (const client of [anon, cliente.client, carrier.client, blockedAdmin.client]) {
      expect((await client.from("porter_package_min_vehicle").select("*")).data ?? []).toEqual([]);
      expect((await client.from("porter_package_min_vehicle").insert({ package_code: "parcels", vehicle_type_id: vt!.id })).error).not.toBeNull();
      expect((await client.from("porter_package_min_vehicle").update({ vehicle_type_id: vt!.id }).eq("package_code", "bilocale").select()).data ?? []).toEqual([]);
    }
  });

  it("admin reads, adds, changes and removes a minimum", async () => {
    const { data: small } = await service.from("vehicle_types").select("id").eq("code", "van_small").single();
    expect((await admin.client.from("porter_package_min_vehicle").select("package_code")).data).toHaveLength(3);
    await check(admin.client.from("porter_package_min_vehicle").insert({ package_code: "parcels", vehicle_type_id: small!.id }));
    const upd = await admin.client.from("porter_package_min_vehicle").update({ vehicle_type_id: small!.id }).eq("package_code", "monolocale").select("package_code");
    expect(upd.data).toHaveLength(1);
    await check(admin.client.from("porter_package_min_vehicle").delete().eq("package_code", "parcels"));
    const { data: medium } = await service.from("vehicle_types").select("id").eq("code", "van_medium").single();
    await check(service.from("porter_package_min_vehicle").update({ vehicle_type_id: medium!.id }).eq("package_code", "monolocale"));
  });
});

describe("create_order stores the goods snapshot (D86)", () => {
  it("largest item, pallets and load category", async () => {
    const [{ data: list }, { data: vt }] = await Promise.all([
      service.from("price_lists").select("id, version").eq("status", "active").single(),
      service.from("vehicle_types").select("id").eq("code", "van_medium").single(),
    ]);
    const now = new Date().toISOString();
    const payload = {
      customer_id: cliente.id,
      vehicle_type_id: vt!.id,
      goods_description: "Divano",
      weight_kg: 300,
      largest_item_length_cm: 220,
      largest_item_width_cm: 90,
      largest_item_height_cm: 85,
      pallets_count: 2,
      load_category: "bilocale",
      pickup_contact_name: "Mario", pickup_contact_phone: "+393331234567",
      delivery_contact_name: "Lucia", delivery_contact_phone: "+393337654321",
      storage: null,
      legs: [{
        leg_index: 0, pickup_address: "A", pickup_lat: 45, pickup_lng: 9, pickup_city: "Milano", pickup_province: "MI",
        delivery_address: "B", delivery_lat: 45, delivery_lng: 7, delivery_city: "Torino", distance_m: 140000,
        pickup_date: "2026-12-01", pickup_window_start: "2026-12-01T09:00:00Z", pickup_window_end: "2026-12-01T11:00:00Z", is_urgent: false,
      }],
      charges: { price_list_id: list!.id, price_list_version: list!.version, customer_type: "private", vat_rate_bp: 2200, subtotal_cents: 10000, vat_cents: 2200, total_cents: 12200, billing_details: {}, terms_accepted_at: now, terms_version: "x", quoted_at: now },
      lines: [{ sort_order: 0, leg_index: 0, line_type: "transport", label_it: "Trasporto", quantity: 1, unit_amount_cents: 10000, net_cents: 10000, vat_cents: 2200, gross_cents: 12200, carrier_share_group: "transport" }],
      carrier_terms: [{ leg_index: 0, carrier_amount_cents: 7000, transport_carrier_cents: 7000 }],
    };
    const { data, error } = await service.rpc("create_order", { p: payload });
    expect(error).toBeNull();
    const order = data as { id: string };
    createdOrders.push(order.id);
    const { data: row } = await service.from("orders").select("weight_kg, largest_item_length_cm, largest_item_width_cm, largest_item_height_cm, pallets_count, load_category").eq("id", order.id).single();
    expect(row).toEqual({ weight_kg: 300, largest_item_length_cm: 220, largest_item_width_cm: 90, largest_item_height_cm: 85, pallets_count: 2, load_category: "bilocale" });

    // customer reads the snapshot of the own order
    const own = await cliente.client.from("orders").select("pallets_count, load_category").eq("id", order.id).single();
    expect(own.data).toEqual({ pallets_count: 2, load_category: "bilocale" });
  });

  it("D176: shipment category and stackable are stored, read by the customer; an unknown category is refused", async () => {
    const [{ data: list }, { data: vt }] = await Promise.all([
      service.from("price_lists").select("id, version").eq("status", "active").single(),
      service.from("vehicle_types").select("id").eq("code", "van_medium").single(),
    ]);
    const now = new Date().toISOString();
    const payload = (patch: Record<string, unknown>) => ({
      customer_id: cliente.id,
      vehicle_type_id: vt!.id,
      goods_description: "Bancali",
      pallets_count: 3,
      pickup_contact_name: "Mario", pickup_contact_phone: "+393331234567",
      delivery_contact_name: "Lucia", delivery_contact_phone: "+393337654321",
      storage: null,
      legs: [{
        leg_index: 0, pickup_address: "A", pickup_lat: 45, pickup_lng: 9, pickup_city: "Milano", pickup_province: "MI",
        delivery_address: "B", delivery_lat: 45, delivery_lng: 7, delivery_city: "Torino", distance_m: 140000,
        pickup_date: "2026-12-01", pickup_window_start: "2026-12-01T09:00:00Z", pickup_window_end: "2026-12-01T11:00:00Z", is_urgent: false,
      }],
      charges: { price_list_id: list!.id, price_list_version: list!.version, customer_type: "private", vat_rate_bp: 2200, subtotal_cents: 10000, vat_cents: 2200, total_cents: 12200, billing_details: {}, terms_accepted_at: now, terms_version: "x", quoted_at: now },
      lines: [{ sort_order: 0, leg_index: 0, line_type: "transport", label_it: "Trasporto", quantity: 1, unit_amount_cents: 10000, net_cents: 10000, vat_cents: 2200, gross_cents: 12200, carrier_share_group: "transport" }],
      carrier_terms: [{ leg_index: 0, carrier_amount_cents: 7000, transport_carrier_cents: 7000 }],
      ...patch,
    });

    const { data, error } = await service.rpc("create_order", { p: payload({ shipment_category: "gitterbox", stackable: true }) });
    expect(error).toBeNull();
    const order = data as { id: string };
    createdOrders.push(order.id);
    const own = await cliente.client.from("orders").select("shipment_category, stackable, pallets_count").eq("id", order.id).single();
    expect(own.data).toEqual({ shipment_category: "gitterbox", stackable: true, pallets_count: 3 });

    // no category (older clients of create_order) = null, not an error
    const plain = await service.rpc("create_order", { p: payload({}) });
    expect(plain.error).toBeNull();
    createdOrders.push((plain.data as { id: string }).id);
    const row = await service.from("orders").select("shipment_category, stackable").eq("id", (plain.data as { id: string }).id).single();
    expect(row.data).toEqual({ shipment_category: null, stackable: null });

    const bad = await service.rpc("create_order", { p: payload({ shipment_category: "container" }) });
    expect(bad.error).not.toBeNull();

    // browsers cannot change it
    const upd = await cliente.client.from("orders").update({ shipment_category: "pallet" }).eq("id", order.id).select("id");
    expect(upd.data ?? []).toEqual([]);
  });

  it("a vehicle type used as a category minimum cannot be deleted", async () => {
    const { data: large } = await service.from("vehicle_types").select("id").eq("code", "van_large").single();
    expect((await service.from("vehicle_types").delete().eq("id", large!.id)).error).not.toBeNull();
  });
});
