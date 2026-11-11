import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { localSql, service, type TestUser } from "./helpers";
import { accept, activeCarrier, check, paidOrder, type DbError, type OrderOpts } from "./job-fixtures";

// Shared fixtures for the job execution tests (carrier-execution, carrier-handover). LOCAL database only (D64).

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(64).fill(1), 0xff, 0xd9]);
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(2)]);
export const STEPS = ["arrived_pickup", "loaded", "departed", "arrived_delivery", "unloaded"] as const;
export type Carrier = Awaited<ReturnType<typeof activeCarrier>>;
export type StepRow = { recorded_at: string; newly_recorded: boolean; order_status: string };

export function sql(statement: string) {
  const res = localSql(statement);
  if (!res.ok) throw new Error(res.output);
  return res.output;
}

/** Moves every leg's pickup window to now (the snapshot is immutable: triggers off, LOCAL test database only). */
export function pickupToday(orderId: string) {
  sql(`set session_replication_role = replica;
    update public.order_legs set pickup_window_start = now() - interval '10 minutes', pickup_window_end = now() + interval '110 minutes'
     where order_id = '${orderId}';
    update public.orders set pickup_window_start = now() - interval '10 minutes' where id = '${orderId}';`);
}

/** Paid order accepted by a fresh active carrier, pickup today. */
export async function runningJob(opts: OrderOpts = {}, today = true): Promise<{ orderId: string; c: Carrier }> {
  const orderId = await paidOrder({ hoursAhead: 72, ...opts });
  const c = await activeCarrier();
  await check(accept(c.user, orderId, c.vehicleId));
  if (today) pickupToday(orderId);
  return { orderId, c };
}

export const step = (u: TestUser, orderId: string, leg: number, s: string, lat?: number, lng?: number) =>
  u.client.rpc("carrier_record_step", { p_order_id: orderId, p_leg_index: leg, p_step: s, p_lat: lat ?? null, p_lng: lng ?? null })
    .single<StepRow>() as unknown as Promise<{ data: StepRow | null; error: DbError }>;

export async function photo(u: TestUser, orderId: string, leg: number, kind: "pickup" | "delivery", path = `${orderId}/${randomUUID()}.jpg`) {
  const up = await u.client.storage.from("order-photos").upload(path, JPEG, { contentType: "image/jpeg" });
  const reg = await u.client.rpc("register_order_photo", { p_order_id: orderId, p_leg_index: leg, p_kind: kind, p_storage_path: path })
    .single<{ photo_id: string; newly_registered: boolean }>();
  return { path, upload: up.error, data: reg.data, error: reg.error as DbError };
}

export async function signature(u: TestUser, orderId: string) {
  const path = `${orderId}/${randomUUID()}.png`;
  const up = await u.client.storage.from("pod-signatures").upload(path, PNG, { contentType: "image/png" });
  if (up.error) throw up.error;
  return path;
}

export const complete = (u: TestUser, orderId: string, name: string | null, path: string | null, lat?: number, lng?: number) =>
  u.client.rpc("complete_delivery", { p_order_id: orderId, p_recipient_name: name, p_signature_path: path, p_lat: lat ?? null, p_lng: lng ?? null })
    .single<{ delivered_at: string; newly_delivered: boolean }>();

/** All five steps of one leg, with the required photos. */
export async function doLeg(u: TestUser, orderId: string, leg: number) {
  for (const s of STEPS) {
    if (s === "loaded") expect((await photo(u, orderId, leg, "pickup")).error).toBeNull();
    if (s === "unloaded") expect((await photo(u, orderId, leg, "delivery")).error).toBeNull();
    const r = await step(u, orderId, leg, s);
    expect(r.error, `${leg}:${s}`).toBeNull();
  }
}

export const order = (id: string) =>
  check(service.from("orders").select("status, picked_up_at, in_transit_at, delivered_at, delivered_without_pod").eq("id", id).single());
export const historyRows = (id: string) =>
  check(service.from("order_status_history").select("from_status, to_status, source, changed_by, note, lat, lng").eq("order_id", id).order("id"));
