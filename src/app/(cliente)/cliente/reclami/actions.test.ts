import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountContext } from "@/lib/auth/routing";

// Claim Server Actions (D138). The real DAL and the real claims server run; the Supabase clients are recorders.
// Checked: anyone who is not a signed-in customer never reaches an RPC, Storage or the service role; the customer's
// calls go through the SESSION client; the service role is touched only after a newly opened claim (team e-mail);
// invalid input never reaches the database.

const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const CLAIM_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  ctx: { state: "anonymous" } as AccountContext,
  events: [] as string[],
  rpcArgs: [] as { fn: string; args: Record<string, unknown> }[],
  openResult: { data: { claim_id: "44444444-4444-4444-8444-444444444444", newly_opened: true }, error: null } as { data: unknown; error: unknown },
  deferred: [] as (() => Promise<void>)[],
}));

function sessionClient() {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.events.push(`session:rpc:${fn}`);
      state.rpcArgs.push({ fn, args });
      return { single: async () => (fn === "open_claim" ? state.openResult : { data: { photo_id: "p", newly_registered: true }, error: null }) };
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUploadUrl: async (path: string) => {
          state.events.push(`session:storage:${bucket}:sign`);
          return { data: { path, signedUrl: `https://storage.example/${path}`, token: "t" }, error: null };
        },
      }),
    },
  };
}

vi.mock("next/server", () => ({ connection: async () => {}, after: (task: () => Promise<void>) => state.deferred.push(task) }));
vi.mock("@/lib/auth/account-context", () => ({ loadAccountContext: async () => state.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessionClient() }));
vi.mock("@/lib/supabase/env", () => ({ getAppUrl: () => "https://transigo.example" }));
vi.mock("@/lib/notifications/email", () => ({
  sendEmail: async (_db: unknown, e: { templateCode: string }) => {
    state.events.push(`mail:${e.templateCode}`);
    return true;
  },
}));
vi.mock("@/lib/supabase/service", () => ({
  // Records every USE, not the creation (the DAL creates one for its session loader — mocked, never used).
  createServiceClient: () => ({
    from: (table: string) => {
      state.events.push(`service:${table}`);
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { order_number: "TG-2026-000001" }, error: null }) }) }) };
    },
  }),
}));

const actions = await import("./actions");
type AnyAction = (input: unknown) => Promise<unknown>;
const exported = (Object.entries(actions) as [string, unknown][]).filter((e): e is [string, AnyAction] => typeof e[1] === "function");

const signedIn = (role: "admin" | "cliente" | "padroncino", isBlocked = false): AccountContext => ({
  state: "signed_in", userId: OTHER_ID, email: "x@example.com", role, isBlocked, firstName: null,
  carrierStatus: role === "padroncino" ? "active" : null,
  customerProfile: role === "cliente" ? "complete" : null,
  customerType: role === "cliente" ? "private" : null,
});
const validInput = () => ({ orderId: ORDER_ID, claimId: CLAIM_ID, category: "delay", description: "Arrivato con tre ore di ritardo.", path: `${CLAIM_ID}/${ORDER_ID}.jpg`, customerId: OTHER_ID });

beforeEach(() => {
  Object.assign(state, { events: [], rpcArgs: [], deferred: [], openResult: { data: { claim_id: CLAIM_ID, newly_opened: true }, error: null } });
  vi.stubEnv("ADMIN_NOTIFICATION_EMAIL", "team@example.com");
});

describe("claim Server Actions", () => {
  it("exports only the three actions", () => {
    expect(Object.keys(actions).sort()).toEqual(["createClaimPhotoUploadAction", "openClaimAction", "registerClaimPhotoAction"]);
  });

  const NON_CUSTOMERS: [string, AccountContext][] = [
    ["not signed in", { state: "anonymous" }],
    ["no profile", { state: "no_profile", userId: OTHER_ID }],
    ["padroncino", signedIn("padroncino")],
    ["admin", signedIn("admin")],
    ["blocked cliente", signedIn("cliente", true)],
  ];
  for (const [who, ctx] of NON_CUSTOMERS) {
    for (const [name, action] of exported) {
      it(`${who} — ${name}: redirected, nothing reached`, async () => {
        state.ctx = ctx;
        await expect(action(validInput())).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
        expect(state.events).toEqual([]);
      });
    }
  }

  describe("cliente", () => {
    beforeEach(() => {
      state.ctx = signedIn("cliente");
    });

    it("openClaimAction: session RPC, then the team e-mail after the response (service role only then)", async () => {
      expect(await actions.openClaimAction(validInput())).toEqual({ ok: true, claimId: CLAIM_ID, newlyOpened: true });
      expect(state.events).toEqual(["session:rpc:open_claim"]);
      expect(state.rpcArgs[0].args).toEqual({ p_order_id: ORDER_ID, p_category: "delay", p_description: "Arrivato con tre ore di ritardo." });
      await Promise.all(state.deferred.map((t) => t()));
      expect(state.events).toEqual(["session:rpc:open_claim", "service:orders", "mail:claim_opened"]);
    });

    it("openClaimAction: an existing open claim → no second e-mail", async () => {
      state.openResult = { data: { claim_id: CLAIM_ID, newly_opened: false }, error: null };
      await actions.openClaimAction(validInput());
      expect(state.deferred).toEqual([]);
    });

    it("openClaimAction: invalid input never reaches the database", async () => {
      const r = await actions.openClaimAction({ orderId: ORDER_ID, category: "delay", description: "corto" });
      expect(r).toMatchObject({ ok: false, errors: { description: expect.any(String) } });
      expect(state.events).toEqual([]);
    });

    it("photo actions: session Storage / RPC only; a path of another claim is refused before the database", async () => {
      expect(await actions.createClaimPhotoUploadAction({ claimId: CLAIM_ID })).toMatchObject({ ok: true });
      expect(await actions.registerClaimPhotoAction({ claimId: CLAIM_ID, path: `${CLAIM_ID}/${ORDER_ID}.jpg` })).toEqual({ ok: true });
      expect(state.events).toEqual(["session:storage:claim-photos:sign", "session:rpc:register_claim_photo"]);
      state.events = [];
      expect(await actions.registerClaimPhotoAction({ claimId: CLAIM_ID, path: `${OTHER_ID}/${ORDER_ID}.jpg` })).toMatchObject({ ok: false });
      expect(await actions.createClaimPhotoUploadAction({ claimId: CLAIM_ID, path: `${OTHER_ID}/${ORDER_ID}.jpg` })).toMatchObject({ ok: false });
      expect(state.events).toEqual([]);
    });
  });
});
