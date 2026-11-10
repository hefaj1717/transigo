import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";
import {
  accept, activeCarrier, addVehicle, approveVehicle, check, doc, FUTURE, history, list, listedIds, orderRow, paidOrder,
  PAST, release, run, setupJobContext, teardownJobContext, vat, type DbError,
} from "./job-fixtures";

// Stage 4.2 — available jobs and "Accetta la Corsa" (D21, D22, D29, D87, D116–D121):
// who may list / accept / release, what the list shows (no personal data), vehicle matching, the race between
// carriers (exactly one winner), "Rinuncia" rules, the vehicle lock while on a job.

let admin: TestUser;
let customer: TestUser;
let vt: Record<string, string>;

beforeAll(async () => {
  ({ admin, customer, vt } = await setupJobContext());
});

afterAll(async () => {
  await teardownJobContext();
  await deleteCreatedUsers().catch(() => undefined);
});

// ---------------------------------------------------------------------------

describe("who may list and accept (D21, D116, TODO from step 4)", () => {
  let orderId: string;
  beforeAll(async () => {
    orderId = await paidOrder();
  });

  it("anon has no access at all", async () => {
    for (const [fn, args] of [
      ["list_available_jobs", {}], ["carrier_job_eligibility", {}],
      ["accept_job", { p_order_id: orderId, p_vehicle_id: randomUUID() }], ["release_job", { p_order_id: orderId }],
    ] as const) {
      expect((await anon.rpc(fn, args)).error).not.toBeNull();
    }
  });

  it("cliente and admin are not carriers (42501 not_carrier)", async () => {
    for (const u of [customer, admin]) {
      const { error } = await list(u);
      expect(error).toMatchObject({ code: "42501", details: "not_carrier" });
      expect((await u.client.rpc("accept_job", { p_order_id: orderId, p_vehicle_id: randomUUID() })).error?.code).toBe("42501");
    }
  });

  it("suspended, pending_review (not sent and sent) and rejected: no list, no accept (carrier_not_active)", async () => {
    const suspended = await activeCarrier();
    await run(service.rpc("set_carrier_suspension", { p_carrier_id: suspended.user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "Controllo" }));

    const notSent = await createUser({ role: "padroncino" });
    await run(service.from("carriers").insert({ profile_id: notSent.id, company_name: "Bozza Srl", vat_number: vat() }));
    const notSentVehicle = await addVehicle(notSent, "van_medium");

    const sent = await createUser({ role: "padroncino" });
    await run(service.from("carriers").insert({
      profile_id: sent.id, company_name: "Inviato Srl", vat_number: vat(), fiscal_code: "RSSMRA80A01H501U",
      hq_street: "Via Roma 1", hq_city: "Milano", hq_postal_code: "20100", hq_province: "MI", sdi_code: "M5UXCR1",
    }));
    await doc(sent, "transport_license");
    await doc(sent, "driving_license", { expires_at: FUTURE });
    const sentVehicle = await addVehicle(sent, "van_medium");
    await run(sent.client.rpc("submit_carrier_for_review"));

    const rejected = await createUser({ role: "padroncino" });
    await run(service.from("carriers").insert({ profile_id: rejected.id, company_name: "Rifiutato Srl", vat_number: vat(), status: "rejected", status_reason: "x" }));
    const rejectedVehicle = await addVehicle(rejected, "van_medium");

    for (const [u, vehicleId] of [[suspended.user, suspended.vehicleId], [notSent, notSentVehicle], [sent, sentVehicle], [rejected, rejectedVehicle]] as const) {
      expect((await list(u)).error).toMatchObject({ code: "42501", details: "carrier_not_active" });
      expect((await accept(u, orderId, vehicleId)).error).toMatchObject({ code: "42501", details: "carrier_not_active" });
      expect(await u.client.rpc("carrier_job_eligibility").single()).toMatchObject({ data: { blockers: ["carrier_not_active"] } });
    }
    expect((await orderRow(orderId)).status).toBe("paid");
  });

  it("a blocked carrier profile (is_blocked) gets nothing", async () => {
    const c = await activeCarrier();
    await run(service.from("profiles").update({ is_blocked: true }).eq("id", c.user.id));
    expect((await list(c.user)).error).toMatchObject({ code: "42501", details: "not_carrier" });
    expect((await accept(c.user, orderId, c.vehicleId)).error?.code).toBe("42501");
  });

  it("an expired or only pending company document blocks new jobs (approved + valid required)", async () => {
    const c = await activeCarrier();
    const patente = (await check(service.from("carrier_documents").select("id").eq("carrier_id", c.user.id).eq("doc_type", "driving_license").single())).id;
    await run(service.from("carrier_documents").update({ expires_at: PAST }).eq("id", patente));
    await doc(c.user, "driving_license", { expires_at: FUTURE }); // renewed, still pending
    expect((await list(c.user)).error).toMatchObject({ code: "42501", details: "document:driving_license" });
    expect((await accept(c.user, orderId, c.vehicleId)).error).toMatchObject({ code: "42501", details: "document:driving_license" });
  });

  it("an active carrier with approved documents sees the job", async () => {
    const c = await activeCarrier();
    expect(await listedIds(c.user)).toContain(orderId);
    expect(await c.user.client.rpc("carrier_job_eligibility").single()).toMatchObject({ data: { blockers: [], ready_vehicle_ids: [c.vehicleId] } });
  });
});

describe("what the list shows (D119): no personal data before accepting", () => {
  it("only safe fields; cities, km, minutes, load, services, the carrier amount", async () => {
    const orderId = await paidOrder({ item: [120, 80, 60], pallets: 2 });
    const c = await activeCarrier();
    const { rows, error } = await list(c.user, orderId);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    const job = rows[0];
    expect(Object.keys(job).sort()).toEqual([
      "carrier_amount_cents", "items_count", "largest_item_height_cm", "largest_item_length_cm", "largest_item_width_cm",
      "legs", "load_category", "matching_vehicle_ids", "order_id", "order_number", "packing_carrier_cents", "packing_items_count",
      "pallets_count", "pickup_window_start", "porters_carrier_cents", "storage_days", "storage_type", "transport_carrier_cents",
      "vehicle_type_name", "weight_kg",
    ]);
    expect(Object.keys(job.legs[0]).sort()).toEqual([
      "carrier_amount_cents", "delivery_city", "delivery_floor", "delivery_has_elevator", "delivery_is_warehouse", "delivery_province",
      "distance_m", "duration_s", "is_urgent", "leg_index", "pickup_city", "pickup_date", "pickup_floor", "pickup_has_elevator",
      "pickup_is_warehouse", "pickup_province", "pickup_window_end", "pickup_window_start", "porter_package_code", "porters_count",
      "porters_included_hours",
    ]);
    expect(job).toMatchObject({ carrier_amount_cents: 11_800, transport_carrier_cents: 7_000, porters_carrier_cents: 4_800, weight_kg: 120, pallets_count: 2 });
    expect(job.legs[0]).toMatchObject({ pickup_city: "Milano", delivery_city: "Torino", distance_m: 143_122, duration_s: 5_400 });
    const text = JSON.stringify(job);
    for (const secret of ["Via Roma", "Via Po", "Mario", "Rossi", "Lucia", "+39", "Divano", "Citofono", "45.46", "place-pickup", "19520", "16000"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("before accepting, the carrier cannot read the order through the tables (RLS)", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    for (const table of ["orders", "order_legs", "order_leg_carrier_terms", "order_status_history"]) {
      const cols = table === "order_status_history" ? "id, order_id, to_status, created_at" : "*"; // D128 column grants
      const { data, error } = await c.user.client.from(table).select(cols).eq(table === "orders" ? "id" : "order_id", orderId);
      expect(error).toBeNull();
      expect(data ?? []).toEqual([]);
    }
  });

  it("a storage order: both legs, the warehouse only as a flag and its city", async () => {
    const orderId = await paidOrder({ storage: true });
    const c = await activeCarrier();
    const job = (await list(c.user, orderId)).rows[0];
    expect(job.storage_type).toBe("short_term");
    expect(job.carrier_amount_cents).toBe(23_600);
    expect(job.legs.map((l) => [l.pickup_is_warehouse, l.delivery_is_warehouse])).toEqual([[false, true], [true, false]]);
    expect(JSON.stringify(job)).not.toContain("Magazzino");
  });
});

describe("vehicle matching (D22, D87)", () => {
  it("own type and smaller; bigger types hidden", async () => {
    const small = await paidOrder({ vehicle: "car", weightKg: 50 });
    const same = await paidOrder({ vehicle: "van_medium" });
    const bigger = await paidOrder({ vehicle: "van_large" });
    const c = await activeCarrier("van_medium", 1200);
    const ids = await listedIds(c.user);
    expect(ids).toEqual(expect.arrayContaining([small, same]));
    expect(ids).not.toContain(bigger);
  });

  it("weight over the vehicle's payload, an item that does not fit, too many pallets → hidden", async () => {
    const heavy = await paidOrder({ weightKg: 1300 });
    const long = await paidOrder({ item: [320, 50, 50] }); // van_medium cargo 300 × 170 × 180
    const rotated = await paidOrder({ item: [170, 280, 100] }); // fits with rotation
    const pallets = await paidOrder({ pallets: 5 }); // van_medium takes 4
    const c = await activeCarrier("van_medium", 1200);
    const ids = await listedIds(c.user);
    expect(ids).not.toContain(heavy);
    expect(ids).not.toContain(long);
    expect(ids).toContain(rotated);
    expect(ids).not.toContain(pallets);
  });

  it("the carrier's own payload and dimensions count (bigger own cargo space fits the long item)", async () => {
    const long = await paidOrder({ item: [320, 50, 50], weightKg: 900 });
    const c = await activeCarrier("van_medium", 800);
    expect(await listedIds(c.user)).not.toContain(long); // 900 kg > own 800 kg
    const v2 = await addVehicle(c.user, "van_medium", { payload_kg: 1100, cargo_length_cm: 340, cargo_width_cm: 170, cargo_height_cm: 180 });
    await run(approveVehicle(v2));
    const job = (await list(c.user, long)).rows[0];
    expect(job.matching_vehicle_ids).toEqual([v2]);
  });

  it("a vehicle not approved, deactivated or with an expired / only pending RCA does not count", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier("car", 400); // too small for the order
    const pending = await addVehicle(c.user, "van_medium", { payload_kg: 1200 }); // not approved yet
    expect(await listedIds(c.user)).not.toContain(orderId);
    await run(approveVehicle(pending));
    expect(await listedIds(c.user)).toContain(orderId);

    const rca = (await check(service.from("carrier_documents").select("id").eq("vehicle_id", pending).eq("doc_type", "insurance_rca").single())).id;
    await run(service.from("carrier_documents").update({ expires_at: PAST }).eq("id", rca));
    await doc(c.user, "insurance_rca", { vehicle_id: pending, expires_at: FUTURE }); // renewed, pending
    expect(await listedIds(c.user)).not.toContain(orderId);
    expect((await accept(c.user, orderId, pending)).error).toMatchObject({ code: "55000", details: "vehicle_not_ready" });
  });
});

describe("accept_job (D120)", () => {
  it("assigns; history paid → assigned; the carrier now reads the full order (contacts) and its amounts", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    const res = await accept(c.user, orderId, c.vehicleId);
    expect(res.error).toBeNull();
    expect(res.data?.newly_assigned).toBe(true);
    expect(await orderRow(orderId)).toMatchObject({ status: "assigned", carrier_id: c.user.id, carrier_vehicle_id: c.vehicleId });
    expect(await history(orderId)).toEqual(expect.arrayContaining([{ from_status: "paid", to_status: "assigned", changed_by: c.user.id, source: "carrier_app" }]));

    const full = await check(c.user.client.from("orders").select("pickup_contact_name, pickup_contact_phone, goods_description").eq("id", orderId).single());
    expect(full).toEqual({ pickup_contact_name: "Mario Rossi", pickup_contact_phone: "+393331234567", goods_description: "Divano di Mario Rossi e 5 scatoloni" });
    expect((await check(c.user.client.from("order_legs").select("pickup_address").eq("order_id", orderId)))[0].pickup_address).toBe("Via Roma 1, 20121 Milano MI");
    expect(await check(c.user.client.from("order_charges").select("total_cents").eq("order_id", orderId))).toEqual([]); // D29
  });

  it("a double click by the same carrier changes nothing (one history entry)", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    const [a, b] = await Promise.all([accept(c.user, orderId, c.vehicleId), accept(c.user, orderId, c.vehicleId)]);
    expect([a.error, b.error]).toEqual([null, null]);
    expect([a.data?.newly_assigned, b.data?.newly_assigned].sort()).toEqual([false, true]);
    expect((await history(orderId)).filter((h) => h.to_status === "assigned")).toHaveLength(1);
  });

  it("the job disappears from other carriers' lists; they get already_taken", async () => {
    const orderId = await paidOrder();
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    await run(accept(a.user, orderId, a.vehicleId));
    expect(await listedIds(b.user)).not.toContain(orderId);
    expect((await accept(b.user, orderId, b.vehicleId)).error).toMatchObject({ code: "55000", details: "already_taken" });
  });

  it("someone else's vehicle → 22023; a vehicle too small → vehicle_not_suitable; unknown order → 22023", async () => {
    const orderId = await paidOrder();
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    expect((await accept(a.user, orderId, b.vehicleId)).error).toMatchObject({ code: "22023", details: "vehicle" });
    const car = await addVehicle(a.user, "car", { payload_kg: 400 });
    await run(approveVehicle(car));
    expect((await accept(a.user, orderId, car)).error).toMatchObject({ code: "55000", details: "vehicle_not_suitable" });
    expect((await accept(a.user, randomUUID(), a.vehicleId)).error).toMatchObject({ code: "22023", details: "order" });
    expect((await orderRow(orderId)).status).toBe("paid");
  });

  it("the carrier still cannot write the order directly", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await c.user.client.from("orders").update({ status: "assigned", carrier_id: c.user.id }).eq("id", orderId);
    expect(await orderRow(orderId)).toMatchObject({ status: "paid", carrier_id: null });
  });
});

describe("race: carriers accepting at the same time (D120)", () => {
  for (const n of [2, 5]) {
    it(`${n} carriers in parallel → exactly one wins, the others get already_taken`, async () => {
      const orderId = await paidOrder();
      const carriers = await Promise.all(Array.from({ length: n }, () => activeCarrier()));
      const results = await Promise.all(carriers.map((c) => accept(c.user, orderId, c.vehicleId)));
      const winners = results.filter((r) => r.error === null);
      const losers = results.filter((r) => r.error !== null);
      expect(winners).toHaveLength(1);
      expect(losers.map((r) => (r.error as DbError)?.details)).toEqual(Array(n - 1).fill("already_taken"));
      const winner = carriers[results.findIndex((r) => r.error === null)];
      expect(await orderRow(orderId)).toMatchObject({ status: "assigned", carrier_id: winner.user.id, carrier_vehicle_id: winner.vehicleId });
      expect((await history(orderId)).filter((h) => h.to_status === "assigned")).toHaveLength(1);
    });
  }
});

describe("release_job — Rinuncia (D121)", () => {
  const ageAssignment = (orderId: string, minutes: number) =>
    run(service.from("orders").update({ assigned_at: new Date(Date.now() - minutes * 60_000).toISOString() }).eq("id", orderId));

  it("within 15 minutes of accepting: back to paid and to the list; history assigned → paid", async () => {
    const orderId = await paidOrder({ hoursAhead: 6 });
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    await run(accept(a.user, orderId, a.vehicleId));
    const res = await release(a.user, orderId);
    expect(res.error).toBeNull();
    expect(res.data?.order_number).toMatch(/^TG-/);
    expect(await orderRow(orderId)).toMatchObject({ status: "paid", carrier_id: null, carrier_vehicle_id: null, assigned_at: null });
    expect((await history(orderId)).at(-1)).toEqual({ from_status: "assigned", to_status: "paid", changed_by: a.user.id, source: "carrier_app" });
    expect(await listedIds(b.user)).toContain(orderId);
    expect((await accept(b.user, orderId, b.vehicleId)).error).toBeNull();
  });

  it("after 15 minutes and less than 48 h before pickup: too_late", async () => {
    const orderId = await paidOrder({ hoursAhead: 30 });
    const c = await activeCarrier();
    await run(accept(c.user, orderId, c.vehicleId));
    await ageAssignment(orderId, 16);
    expect((await release(c.user, orderId)).error).toMatchObject({ code: "55000", details: "too_late" });
    expect((await orderRow(orderId)).status).toBe("assigned");
  });

  it("after 15 minutes but 48 h or more before pickup: allowed", async () => {
    const orderId = await paidOrder({ hoursAhead: 72 });
    const c = await activeCarrier();
    await run(accept(c.user, orderId, c.vehicleId));
    await ageAssignment(orderId, 60);
    expect((await release(c.user, orderId)).error).toBeNull();
  });

  it("only the assigned carrier, only in status assigned", async () => {
    const orderId = await paidOrder();
    const [a, b] = await Promise.all([activeCarrier(), activeCarrier()]);
    expect((await release(a.user, orderId)).error).toMatchObject({ code: "55000", details: "not_assigned" }); // not accepted yet
    await run(accept(a.user, orderId, a.vehicleId));
    expect((await release(b.user, orderId)).error).toMatchObject({ code: "55000", details: "not_assigned" });
    expect((await customer.client.rpc("release_job", { p_order_id: orderId })).error?.code).toBe("42501");
  });

  it("a suspended carrier keeps the job (reads it) and may release it under the same rules (D116)", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await run(accept(c.user, orderId, c.vehicleId));
    await run(service.rpc("set_carrier_suspension", { p_carrier_id: c.user.id, p_admin_id: admin.id, p_suspend: true, p_reason: "Controllo" }));
    expect((await check(c.user.client.from("orders").select("id").eq("id", orderId))).map((o) => o.id)).toEqual([orderId]);
    expect((await release(c.user, orderId)).error).toBeNull();
  });
});

describe("vehicle on a job cannot be deactivated or change type / payload (every role)", () => {
  it("assigned: carrier and service role refused; cargo dimensions still editable; free again after release", async () => {
    const orderId = await paidOrder();
    const c = await activeCarrier();
    await run(accept(c.user, orderId, c.vehicleId));

    for (const change of [{ is_active: false }, { payload_kg: 1500 }, { vehicle_type_id: vt.van_large }]) {
      expect((await c.user.client.from("carrier_vehicles").update(change).eq("id", c.vehicleId)).error?.code).toBe("55000");
      expect((await service.from("carrier_vehicles").update(change).eq("id", c.vehicleId)).error?.code).toBe("55000");
    }
    expect((await c.user.client.from("carrier_vehicles").update({ cargo_length_cm: 290 }).eq("id", c.vehicleId)).error).toBeNull();

    await run(release(c.user, orderId));
    expect((await c.user.client.from("carrier_vehicles").update({ is_active: false }).eq("id", c.vehicleId)).error).toBeNull();
  });
});
