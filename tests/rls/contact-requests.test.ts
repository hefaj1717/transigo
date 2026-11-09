import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { setContactRequestStatus, submitContactRequest } from "@/lib/contact/server";
import { anon, createUser, deleteCreatedUsers, localSql, service, type TestUser } from "./helpers";

// Stage 2c, step 4 — contact requests (D125): admin-only reads, inserts only through submit_contact_request()
// with a per-IP rate limit (5/hour, 20/day), status changes with audit, retention purge.

const ipHash = () => randomBytes(32).toString("hex");
const run = async (p: PromiseLike<{ error: unknown }>) => {
  const { error } = await p;
  if (error) throw error;
};

type SubmitArgs = Partial<{
  p_kind: "general" | "out_of_area"; p_name: string; p_email: string; p_phone: string | null; p_message: string;
  p_privacy_accepted: boolean; p_ip_hash: string; p_pickup_city: string | null; p_pickup_province: string | null;
  p_delivery_city: string | null; p_delivery_province: string | null; p_route_distance_km: number | null;
}>;

const submit = (args: SubmitArgs = {}) =>
  service.rpc("submit_contact_request", {
    p_kind: "general", p_name: "Mario Rossi", p_email: "mario@example.com", p_phone: null, p_message: "Vorrei informazioni.",
    p_privacy_accepted: true, p_ip_hash: ipHash(), ...args,
  });

async function created(args: SubmitArgs = {}): Promise<string> {
  const { data, error } = await submit(args);
  if (error) throw error;
  const row = (data as { request_id: string | null; result: string }[])[0];
  expect(row.result).toBe("created");
  return row.request_id!;
}

const setStatus = (id: string, status: "new" | "handled", adminId: string) =>
  service.rpc("admin_set_contact_request_status", { p_request_id: id, p_status: status, p_admin_id: adminId });

let admin: TestUser;
let blockedAdmin: TestUser;
let cliente: TestUser;
let padroncino: TestUser;

beforeAll(async () => {
  [admin, blockedAdmin, cliente, padroncino] = await Promise.all([createUser({}), createUser({}), createUser({}), createUser({ role: "padroncino" })]);
  await run(service.from("profiles").update({ role: "admin" }).in("id", [admin.id, blockedAdmin.id]));
  await run(service.from("profiles").update({ is_blocked: true }).eq("id", blockedAdmin.id));
});

afterAll(async () => {
  localSql("delete from public.contact_requests; delete from public.email_outbox where template_code = 'contact_request';");
  await deleteCreatedUsers();
});

describe("who can read and write contact_requests", () => {
  it("admin reads; anonymous, cliente and padroncino see nothing", async () => {
    const id = await created();
    const { data: asAdmin } = await admin.client.from("contact_requests").select("id, name, email").eq("id", id);
    expect(asAdmin).toEqual([{ id, name: "Mario Rossi", email: "mario@example.com" }]);
    for (const c of [anon, cliente.client, padroncino.client, blockedAdmin.client]) {
      const { data } = await c.from("contact_requests").select("id").eq("id", id);
      expect(data ?? []).toEqual([]);
    }
  });

  it("nobody inserts or updates directly — not even the service role", async () => {
    const row = { kind: "general", name: "X", email: "x@example.com", message: "m", privacy_accepted_at: new Date().toISOString(), privacy_version: "v" };
    for (const c of [anon, cliente.client, admin.client, service]) {
      const { error } = await c.from("contact_requests").insert(row);
      expect(error).not.toBeNull();
    }
    const id = await created();
    for (const c of [admin.client, service]) {
      const { error } = await c.from("contact_requests").update({ status: "handled", handled_at: new Date().toISOString() }).eq("id", id);
      expect(error).not.toBeNull();
    }
    const { data } = await service.from("contact_requests").select("status").eq("id", id).single();
    expect(data?.status).toBe("new");
  });

  it("only the service role may call the functions", async () => {
    for (const c of [anon, cliente.client, admin.client]) {
      expect((await c.rpc("submit_contact_request", { p_kind: "general", p_name: "X", p_email: "x@example.com", p_phone: null, p_message: "m", p_privacy_accepted: true, p_ip_hash: ipHash() })).error).not.toBeNull();
      expect((await c.rpc("purge_contact_requests")).error).not.toBeNull();
    }
    const id = await created();
    expect((await admin.client.rpc("admin_set_contact_request_status", { p_request_id: id, p_status: "handled", p_admin_id: admin.id })).error).not.toBeNull();
  });
});

describe("submit_contact_request", () => {
  it("stores the consent time and the current privacy version, normalises fields", async () => {
    const id = await created({ p_email: "  Mario@Example.COM ", p_phone: "  ", p_name: "  Mario  " });
    const { data } = await service.from("contact_requests").select("*").eq("id", id).single();
    const { data: settings } = await service.from("settings").select("privacy_version").single();
    expect(data).toMatchObject({ status: "new", kind: "general", name: "Mario", email: "mario@example.com", phone: null, privacy_version: settings!.privacy_version });
    expect(data!.privacy_accepted_at).toBeTruthy();
  });

  it("refuses a request without consent or without the ip hash", async () => {
    expect((await submit({ p_privacy_accepted: false })).error).toMatchObject({ code: "22023" });
    expect((await submit({ p_ip_hash: "1.2.3.4" })).error).toMatchObject({ code: "22023" });
  });

  it("checks the fields (e-mail format, empty message, route fields only for out_of_area)", async () => {
    expect((await submit({ p_email: "not-an-email" })).error).toMatchObject({ code: "23514" });
    expect((await submit({ p_message: "   " })).error).toMatchObject({ code: "23514" });
    expect((await submit({ p_pickup_city: "Roma", p_pickup_province: "RM" })).error).toMatchObject({ code: "23514" });
    const id = await created({ p_kind: "out_of_area", p_pickup_city: "Roma", p_pickup_province: "rm", p_delivery_city: "Napoli", p_delivery_province: "NA", p_route_distance_km: 225 });
    const { data } = await service.from("contact_requests").select("pickup_province, route_distance_km").eq("id", id).single();
    expect(data).toEqual({ pickup_province: "RM", route_distance_km: 225 });
  });

  it("allows 5 per hour from one IP, the 6th is rate limited; another IP is not affected", async () => {
    const ip = ipHash();
    for (let i = 0; i < 5; i++) await created({ p_ip_hash: ip });
    const { data } = await submit({ p_ip_hash: ip });
    expect(data).toEqual([{ request_id: null, result: "rate_limited" }]);
    await created(); // other IP
  });

  it("allows 20 per day from one IP", async () => {
    const ip = ipHash();
    // 19 older than one hour (hour limit not reached), then one more fits, the 21st does not
    const values = Array.from({ length: 19 }, () => `('general','N','n@example.com','m',now(),'v','${ip}', now() - interval '2 hours')`).join(",");
    const res = localSql(`insert into public.contact_requests (kind, name, email, message, privacy_accepted_at, privacy_version, ip_hash, created_at) values ${values};`);
    expect(res.ok, res.output).toBe(true);
    await created({ p_ip_hash: ip });
    const { data } = await submit({ p_ip_hash: ip });
    expect(data).toEqual([{ request_id: null, result: "rate_limited" }]);
  });

  it("10 concurrent submissions from one IP create exactly 5 rows", async () => {
    const ip = ipHash();
    const results = await Promise.all(Array.from({ length: 10 }, () => submit({ p_ip_hash: ip })));
    const outcomes = results.map((r) => (r.data as { result: string }[] | null)?.[0]?.result ?? `error ${String(r.error)}`);
    expect(outcomes.filter((o) => o === "created")).toHaveLength(5);
    expect(outcomes.filter((o) => o === "rate_limited")).toHaveLength(5);
    const { count } = await service.from("contact_requests").select("id", { count: "exact", head: true }).eq("ip_hash", ip);
    expect(count).toBe(5);
  });
});

describe("admin_set_contact_request_status", () => {
  it("handled ↔ new with audit (ids and status only)", async () => {
    const id = await created();
    expect((await setStatus(id, "handled", admin.id)).data).toBe("handled");
    let { data } = await service.from("contact_requests").select("status, handled_at, handled_by").eq("id", id).single();
    expect(data).toMatchObject({ status: "handled", handled_by: admin.id });
    expect(data!.handled_at).toBeTruthy();

    expect((await setStatus(id, "new", admin.id)).data).toBe("new");
    ({ data } = await service.from("contact_requests").select("status, handled_at, handled_by").eq("id", id).single());
    expect(data).toEqual({ status: "new", handled_at: null, handled_by: null });

    const { data: log } = await service.from("audit_log").select("action, actor_id, actor_email, data").eq("entity_id", id).order("id");
    expect(log).toEqual([
      { action: "contact_request.handled", actor_id: admin.id, actor_email: admin.email, data: { from: "new", to: "handled" } },
      { action: "contact_request.reopened", actor_id: admin.id, actor_email: admin.email, data: { from: "handled", to: "new" } },
    ]);
  });

  it("refuses non-admins, blocked admins, repeated status and unknown requests", async () => {
    const id = await created();
    for (const u of [cliente, padroncino, blockedAdmin]) expect((await setStatus(id, "handled", u.id)).error).toMatchObject({ code: "42501" });
    expect((await setStatus(id, "new", admin.id)).error).toMatchObject({ code: "55000" });
    expect((await setStatus("00000000-0000-4000-8000-000000000000", "handled", admin.id)).error).toMatchObject({ code: "22023" });
  });
});

describe("purge_contact_requests (D125)", () => {
  it("deletes handled requests 24 months after handled_at, keeps the rest; clears ip_hash after 30 days", async () => {
    const [oldHandled, recentHandled, oldNew, oldIp] = [await created(), await created(), await created(), await created()];
    await run(setStatus(oldHandled, "handled", admin.id));
    await run(setStatus(recentHandled, "handled", admin.id));
    const res = localSql(`
      update public.contact_requests set handled_at = now() - interval '24 months 1 day', created_at = now() - interval '25 months' where id = '${oldHandled}';
      update public.contact_requests set handled_at = now() - interval '23 months' where id = '${recentHandled}';
      update public.contact_requests set created_at = now() - interval '36 months' where id = '${oldNew}';
      update public.contact_requests set created_at = now() - interval '31 days' where id = '${oldIp}';
    `);
    expect(res.ok, res.output).toBe(true);

    const { data, error } = await service.rpc("purge_contact_requests");
    expect(error).toBeNull();
    expect((data as { deleted: number }[])[0].deleted).toBeGreaterThanOrEqual(1);

    const { data: left } = await service.from("contact_requests").select("id, ip_hash").in("id", [oldHandled, recentHandled, oldNew, oldIp]);
    const byId = new Map((left ?? []).map((r) => [r.id, r.ip_hash]));
    expect(byId.has(oldHandled)).toBe(false);
    expect(byId.has(recentHandled)).toBe(true);
    expect(byId.has(oldNew)).toBe(true); // unhandled requests are never purged
    expect(byId.get(oldNew)).toBeNull(); // but their ip hash is cleared
    expect(byId.get(oldIp)).toBeNull();
    expect(byId.get(recentHandled)).not.toBeNull();
  });
});

describe("server code on the real database (submitContactRequest, setContactRequestStatus)", () => {
  const input = { name: "Lucia Bianchi", email: "lucia@example.com", phone: "+39 333 1234567", message: "Messaggio di prova per il server.", privacy: "on" as const };

  it("saves the request and queues the team e-mail without personal data", async () => {
    const r = await submitContactRequest({ db: service, ipHash: ipHash(), appUrl: "http://localhost:3000", adminEmail: "team@example.com" }, input);
    expect(r.status).toBe("created");
    if (r.status !== "created") return;
    const { data: row } = await service.from("contact_requests").select("kind, name, phone").eq("id", r.id).single();
    expect(row).toEqual({ kind: "general", name: "Lucia Bianchi", phone: "+39 333 1234567" });

    const { data: mails } = await service.from("email_outbox").select("to_address, subject, html, text_body, status").eq("template_code", "contact_request").like("text_body", `%${r.id}%`);
    expect(mails).toHaveLength(1);
    expect(mails![0]).toMatchObject({ to_address: "team@example.com", status: "captured_dev" });
    const body = `${mails![0].subject} ${mails![0].html} ${mails![0].text_body}`;
    for (const personal of ["Lucia", "lucia@example.com", "333 1234567", "Messaggio di prova"]) expect(body).not.toContain(personal);
    expect(body).toContain(`/admin/richieste/${r.id}`);
  });

  it("a second request also gets its e-mail (outbox uniqueness is per order, not per template)", async () => {
    const deps = { db: service, ipHash: ipHash(), appUrl: "http://localhost:3000", adminEmail: "team@example.com" };
    const [a, b] = [await submitContactRequest(deps, input), await submitContactRequest(deps, input)];
    const ids = [a, b].map((x) => (x.status === "created" ? x.id : ""));
    const { count } = await service.from("email_outbox").select("id", { count: "exact", head: true }).eq("template_code", "contact_request").or(ids.map((id) => `text_body.like.%${id}%`).join(","));
    expect(count).toBe(2);
  });

  it("out_of_area route fields; rate limit reported", async () => {
    const ip = ipHash();
    const deps = { db: service, ipHash: ip, appUrl: "http://x", adminEmail: null };
    const r = await submitContactRequest(deps, input, { pickupCity: "Bari", pickupProvince: "BA", deliveryCity: "Lecce", deliveryProvince: "LE", distanceKm: 150 });
    expect(r.status).toBe("created");
    for (let i = 0; i < 4; i++) await submitContactRequest(deps, input);
    expect(await submitContactRequest(deps, input)).toEqual({ status: "rate_limited" });
  });

  it("setContactRequestStatus maps database refusals to Italian messages", async () => {
    const id = await created();
    const deps = { admin: { userId: admin.id, email: admin.email }, serviceDb: service };
    expect(await setContactRequestStatus(deps, { id, status: "handled" })).toEqual({ ok: true, message: "Richiesta segnata come gestita." });
    expect(await setContactRequestStatus(deps, { id, status: "handled" })).toMatchObject({ ok: false, error: expect.stringMatching(/già cambiato/) });
    expect(await setContactRequestStatus(deps, { id: "not-a-uuid", status: "handled" })).toEqual({ ok: false, error: "Richiesta non valida." });
    expect(await setContactRequestStatus({ ...deps, admin: { userId: cliente.id, email: cliente.email } }, { id, status: "new" })).toEqual({ ok: false, error: "Operazione non consentita." });
  });
});
