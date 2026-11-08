import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, createUser, deleteCreatedUsers, deleteUserNow, service, type TestUser } from "./helpers";

// audit_log keeps its author after the account is deleted and is append-only (D65).

let admin: TestUser;
let cliente: TestUser;
let carrier: TestUser;
const entityId = crypto.randomUUID();

/** Same insert as audit() in src/lib/admin/server.ts. */
async function writeEntry(actor: TestUser, action: string) {
  const { data, error } = await service
    .from("audit_log")
    .insert({ actor_id: actor.id, actor_email: actor.email, action, entity_type: "price_list", entity_id: entityId, data: { test: true } })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as number;
}

beforeAll(async () => {
  admin = await createUser({});
  cliente = await createUser({});
  carrier = await createUser({ role: "padroncino" });
  const { error } = await service.from("profiles").update({ role: "admin" }).eq("id", admin.id);
  if (error) throw error;
});

afterAll(async () => {
  await deleteCreatedUsers();
});

describe("audit_log", () => {
  it("only admin reads entries", async () => {
    await writeEntry(admin, "price_list.publish");
    const { data } = await admin.client.from("audit_log").select("action, actor_email").eq("entity_id", entityId);
    expect(data).toEqual([{ action: "price_list.publish", actor_email: admin.email }]);
    for (const client of [anon, cliente.client, carrier.client]) {
      const { data: none } = await client.from("audit_log").select("id").eq("entity_id", entityId);
      expect(none ?? []).toEqual([]);
    }
  });

  it("nobody but the server writes entries", async () => {
    for (const client of [admin.client, cliente.client, anon]) {
      const { error } = await client.from("audit_log").insert({ actor_id: admin.id, action: "x", entity_type: "x" });
      expect(error).not.toBeNull();
    }
  });

  it("is append-only, also for the service role", async () => {
    const id = await writeEntry(admin, "settings.update");
    const upd = await service.from("audit_log").update({ action: "changed" }).eq("id", id);
    expect(upd.error?.message).toMatch(/append-only/);
    const del = await service.from("audit_log").delete().eq("id", id);
    expect(del.error?.message).toMatch(/append-only/);
    const { data } = await service.from("audit_log").select("action").eq("id", id).single();
    expect(data?.action).toBe("settings.update");
  });

  it("keeps actor_id and actor_email after the author's account is deleted", async () => {
    const author = await createUser({});
    await service.from("profiles").update({ role: "admin" }).eq("id", author.id);
    const id = await writeEntry(author, "price_list.publish");

    await deleteUserNow(author);

    const { data: profile } = await service.from("profiles").select("id").eq("id", author.id).maybeSingle();
    expect(profile).toBeNull();
    const { data } = await service.from("audit_log").select("actor_id, actor_email, action").eq("id", id).single();
    expect(data).toEqual({ actor_id: author.id, actor_email: author.email, action: "price_list.publish" });
  });
});
