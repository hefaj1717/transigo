import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountContext } from "@/lib/auth/routing";

// Every admin Server Action on carriers refuses non-admins BEFORE anything reaches the server code or the
// service-role client (D101: p_admin_id always from the session). The real DAL (requireArea → routing) runs;
// only the session loading, Supabase clients and the server code are replaced.

const session = vi.hoisted(() => ({ ctx: { state: "anonymous" } as AccountContext }));
const serviceAccess = vi.hoisted(() => ({ props: [] as string[] }));
const server = vi.hoisted(() => ({
  decideCarrier: vi.fn(async () => ({ ok: true, message: "ok" })),
  reviewDocument: vi.fn(async () => ({ ok: true, message: "ok" })),
  approveVehicle: vi.fn(async () => ({ ok: true, message: "ok" })),
  setSuspension: vi.fn(async () => ({ ok: true, message: "ok" })),
  setCarrierPorters: vi.fn(async () => ({ ok: true, message: "ok" })),
  updateCarrierCompany: vi.fn(async () => ({ ok: true, message: "ok", changed: [] })),
}));

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/account-context", () => ({ loadAccountContext: async () => session.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/env", () => ({ getAppUrl: () => "https://transigo.example" }));
// Records any use of the service-role client (rpc, from, storage, …). The DAL creates one for the session
// loader (mocked here, so it is never used).
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () =>
    new Proxy({}, { get: (_t, prop) => { serviceAccess.props.push(String(prop)); return () => { throw new Error("service client used"); }; } }),
}));
vi.mock("@/lib/carriers/admin-server", () => server);

const actions = await import("./actions");

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";

const signedIn = (role: "admin" | "cliente" | "padroncino", isBlocked = false): AccountContext => ({
  state: "signed_in", userId: ADMIN_ID, email: "x@example.com", role, isBlocked, firstName: null,
  carrierStatus: role === "padroncino" ? "active" : null,
  customerProfile: role === "cliente" ? "complete" : null,
  customerType: role === "cliente" ? "private" : null,
});

const NON_ADMINS: [string, AccountContext][] = [
  ["not signed in", { state: "anonymous" }],
  ["no profile", { state: "no_profile", userId: OTHER_ID }],
  ["cliente", signedIn("cliente")],
  ["padroncino", signedIn("padroncino")],
  ["blocked admin", signedIn("admin", true)],
];

function form(): FormData {
  const fd = new FormData();
  // Includes fields an attacker might add: they must never become the admin id.
  for (const [k, v] of Object.entries({ id: TARGET, carrierId: TARGET, decision: "approve", reason: "Motivo", offers: "on", team: "3", adminId: OTHER_ID, p_admin_id: OTHER_ID })) fd.set(k, v);
  return fd;
}

type AnyAction = (prev: object, fd: FormData) => Promise<unknown>;
const exported = (Object.entries(actions) as [string, unknown][]).filter((e): e is [string, AnyAction] => typeof e[1] === "function");

beforeEach(() => {
  serviceAccess.props = [];
  for (const fn of Object.values(server)) fn.mockClear();
});

describe("admin carrier Server Actions", () => {
  it("the file exports the expected actions (a new action is covered automatically)", () => {
    expect(exported.map(([name]) => name).sort()).toEqual([
      "approveVehicleAction", "decideCarrierAction", "reviewDocumentAction", "setCarrierPortersAction", "setSuspensionAction", "updateCompanyAction",
    ]);
  });

  for (const [who, ctx] of NON_ADMINS) {
    describe(who, () => {
      for (const [name, action] of exported) {
        it(`${name}: redirected, nothing reaches the server code or the service role`, async () => {
          session.ctx = ctx;
          await expect(action({}, form())).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
          for (const fn of Object.values(server)) expect(fn).not.toHaveBeenCalled();
          expect(serviceAccess.props).toEqual([]);
        });
      }
    });
  }

  describe("admin", () => {
    for (const [name, action] of exported) {
      it(`${name}: runs with the session's admin id, never the form's`, async () => {
        session.ctx = signedIn("admin");
        await action({}, form());
        const calls = Object.values(server).flatMap((fn) => fn.mock.calls as unknown as [{ admin: { userId: string } }][]);
        expect(calls).toHaveLength(1);
        expect(calls[0][0].admin).toEqual({ userId: ADMIN_ID, email: "x@example.com" });
      });
    }
  });
});
