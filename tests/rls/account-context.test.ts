import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAccountContext } from "@/lib/auth/account-context";
import { AREA_HOME, carrierPanelView, resolveAreaAccess, resolvePostSignIn, type AccountContext, type Area } from "@/lib/auth/routing";
import { anon, createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";

// End-to-end check of route protection (D46) against the real database:
// real users of every role → loadAccountContext (same code the DAL uses) → routing rules.

const areas: Area[] = ["cliente", "padroncino", "admin"];
const vat = () => Math.floor(Math.random() * 1e11).toString().padStart(11, "0");

type Case = { label: string; user: TestUser; home: string; carrierView?: "active" | "pending" };
const cases: Case[] = [];
let blockedCliente: TestUser;
let blockedCarrier: TestUser;

async function check(r: PromiseLike<{ error: unknown }>) {
  const { error } = await r;
  if (error) throw error;
}

beforeAll(async () => {
  const cliente = await createUser({ role: "cliente", first_name: "Carla" });
  const fakeAdmin = await createUser({ role: "admin" }); // must become cliente (D37)
  const admin = await createUser({});
  const carriers = await Promise.all(
    (["pending_review", "active", "rejected", "suspended"] as const).map(async (status) => ({
      status,
      user: await createUser({ role: "padroncino" }),
    })),
  );
  blockedCliente = await createUser({});
  blockedCarrier = await createUser({ role: "padroncino" });

  await check(service.from("profiles").update({ role: "admin" }).eq("id", admin.id));
  await check(service.from("profiles").update({ is_blocked: true }).in("id", [blockedCliente.id, blockedCarrier.id]));
  await check(service.from("customers").insert([
    { profile_id: cliente.id, customer_type: "private" },
    { profile_id: fakeAdmin.id, customer_type: "private" },
    { profile_id: blockedCliente.id, customer_type: "private" },
  ]));
  await check(service.from("carriers").insert([
    ...carriers.map(({ status, user }) => ({ profile_id: user.id, company_name: `T ${status}`, vat_number: vat(), status })),
    { profile_id: blockedCarrier.id, company_name: "T blocked", vat_number: vat(), status: "active" },
  ]));

  cases.push(
    { label: "cliente", user: cliente, home: "/cliente" },
    { label: "sign-up with role=admin in metadata", user: fakeAdmin, home: "/cliente" },
    { label: "admin", user: admin, home: "/admin" },
    ...carriers.map(({ status, user }): Case => ({
      label: `padroncino ${status}`,
      user,
      home: "/padroncino",
      carrierView: status === "active" ? "active" : "pending",
    })),
  );
});

afterAll(async () => {
  await deleteCreatedUsers();
});

async function contextOf(user: TestUser): Promise<AccountContext> {
  return loadAccountContext(user.client, service);
}

describe("every role reaches only its own panel (real accounts)", () => {
  it("each account is routed to its home and redirected away from the other panels", async () => {
    expect(cases.length).toBe(7);
    for (const c of cases) {
      const ctx = await contextOf(c.user);
      expect(ctx.state, c.label).toBe("signed_in");
      expect(resolvePostSignIn(ctx), c.label).toBe(c.home);
      for (const area of areas) {
        const expected = AREA_HOME[area] === c.home ? { kind: "allow" } : { kind: "redirect", to: c.home };
        expect(resolveAreaAccess(ctx, area), `${c.label} → /${area}`).toEqual(expected);
      }
    }
  });

  it("only an active carrier gets the full carrier panel", async () => {
    for (const c of cases.filter((x) => x.carrierView)) {
      const ctx = await contextOf(c.user);
      if (ctx.state !== "signed_in") throw new Error("expected signed in");
      expect(carrierPanelView(ctx), c.label).toBe(c.carrierView);
    }
  });

  it("first name comes from the sign-up metadata", async () => {
    const ctx = await contextOf(cases[0].user);
    expect(ctx).toMatchObject({ state: "signed_in", firstName: "Carla", role: "cliente" });
  });
});

describe("blocked and anonymous", () => {
  it("blocked accounts (cliente and active padroncino) go to /account-sospeso from every panel", async () => {
    for (const user of [blockedCliente, blockedCarrier]) {
      const ctx = await contextOf(user);
      expect(ctx).toMatchObject({ state: "signed_in", isBlocked: true });
      expect(resolvePostSignIn(ctx)).toBe("/account-sospeso");
      for (const area of areas) {
        expect(resolveAreaAccess(ctx, area)).toEqual({ kind: "redirect", to: "/account-sospeso" });
      }
    }
  });

  it("a blocked user still cannot read own data through RLS (the DAL needs the service role for this)", async () => {
    const { data } = await blockedCliente.client.from("profiles").select("is_blocked");
    expect(data ?? []).toEqual([]);
  });

  it("no session → anonymous → /accedi", async () => {
    const ctx = await loadAccountContext(anon, service);
    expect(ctx).toEqual({ state: "anonymous" });
    for (const area of areas) {
      expect(resolveAreaAccess(ctx, area)).toEqual({ kind: "redirect", to: `/accedi?next=${encodeURIComponent(AREA_HOME[area])}` });
    }
  });
});
