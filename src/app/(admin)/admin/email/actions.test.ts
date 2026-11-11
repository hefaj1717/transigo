import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountContext } from "@/lib/auth/routing";

// Every "Invia di nuovo" action refuses non-admins BEFORE anything reaches the server code or the service-role
// client; for an admin the actor comes from the session, never from the form (D131).

const session = vi.hoisted(() => ({ ctx: { state: "anonymous" } as AccountContext }));
const serviceAccess = vi.hoisted(() => ({ props: [] as string[] }));
const server = vi.hoisted(() => ({
  resendOutboxEmail: vi.fn(async () => ({ ok: true, message: "ok" })),
  resendDeliveredEmail: vi.fn(async () => ({ ok: true, message: "ok" })),
  ADMIN_EMAIL_PATHS: { list: "/admin/email" },
}));

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/account-context", () => ({ loadAccountContext: async () => session.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/env", () => ({ getAppUrl: () => "https://transigo.example" }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () =>
    new Proxy({}, { get: (_t, prop) => { serviceAccess.props.push(String(prop)); return () => { throw new Error("service client used"); }; } }),
}));
vi.mock("@/lib/notifications/admin-outbox", () => server);

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
  for (const [k, v] of Object.entries({ id: TARGET, orderId: TARGET, adminId: OTHER_ID, p_admin_id: OTHER_ID })) fd.set(k, v);
  return fd;
}

type AnyAction = (prev: object, fd: FormData) => Promise<unknown>;
const exported = (Object.entries(actions) as [string, unknown][]).filter((e): e is [string, AnyAction] => typeof e[1] === "function");

beforeEach(() => {
  serviceAccess.props = [];
  server.resendOutboxEmail.mockClear();
  server.resendDeliveredEmail.mockClear();
});

describe("admin e-mail Server Actions", () => {
  it("the file exports the expected actions (a new action is covered automatically)", () => {
    expect(exported.map(([name]) => name).sort()).toEqual(["resendDeliveredEmailAction", "resendEmailAction"]);
  });

  for (const [who, ctx] of NON_ADMINS) {
    describe(who, () => {
      for (const [name, action] of exported) {
        it(`${name}: redirected, nothing reaches the server code or the service role`, async () => {
          session.ctx = ctx;
          await expect(action({}, form())).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
          expect(server.resendOutboxEmail).not.toHaveBeenCalled();
          expect(server.resendDeliveredEmail).not.toHaveBeenCalled();
          expect(serviceAccess.props).toEqual([]);
        });
      }
    });
  }

  it("admin: the actor is the session's, the target the form's id", async () => {
    session.ctx = signedIn("admin");
    await actions.resendEmailAction({}, form());
    await actions.resendDeliveredEmailAction({}, form());
    const a = server.resendOutboxEmail.mock.calls as unknown as [{ admin: unknown }, string][];
    const b = server.resendDeliveredEmail.mock.calls as unknown as [{ admin: unknown }, string][];
    expect(a).toEqual([[expect.objectContaining({ admin: { userId: ADMIN_ID, email: "x@example.com" } }), TARGET]]);
    expect(b).toEqual([[expect.objectContaining({ admin: { userId: ADMIN_ID, email: "x@example.com" } }), TARGET]]);
  });
});
