import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountContext } from "@/lib/auth/routing";

// Customer order Server Actions (payNow, cancelUnpaid, cancelPaid). The real DAL (requireArea → routing) runs; the
// payment and cancellation servers and the Supabase clients are recorders. Checked: anyone who is not a signed-in
// customer is redirected before any service role, Stripe or database call; the customer id passed on is always the
// session's, never one from the form.

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";

const state = vi.hoisted(() => ({
  ctx: { state: "anonymous" } as AccountContext,
  events: [] as string[],
  cancelArgs: [] as unknown[][],
}));

vi.mock("next/server", () => ({ connection: async () => {}, after: vi.fn() }));
vi.mock("@/lib/auth/account-context", () => ({ loadAccountContext: async () => state.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/env", () => ({ getAppUrl: () => "https://transigo.example" }));
vi.mock("@/lib/supabase/service", () => ({
  // Records every USE, not the creation (the DAL creates one for its session loader — mocked, never used).
  createServiceClient: () => new Proxy({}, { get: (_t, prop) => { state.events.push(`service:${String(prop)}`); return undefined; } }),
}));
vi.mock("@/lib/payments/server", () => ({
  startCheckout: async () => {
    state.events.push("startCheckout");
    return { kind: "processing" };
  },
  cancelUnpaidOrder: async () => {
    state.events.push("cancelUnpaidOrder");
    return { ok: true };
  },
}));
vi.mock("@/lib/orders/cancellation-server", () => ({
  cancellationDeps: () => ({}),
  cancelOrderForCustomer: async (...args: unknown[]) => {
    state.events.push("cancelOrderForCustomer");
    state.cancelArgs.push(args);
    return { ok: true, kind: "review" };
  },
}));

const actions = await import("./actions");

const signedIn = (role: "admin" | "cliente" | "padroncino", isBlocked = false): AccountContext => ({
  state: "signed_in", userId: USER_ID, email: "x@example.com", role, isBlocked, firstName: null,
  carrierStatus: role === "padroncino" ? "active" : null,
  customerProfile: role === "cliente" ? "complete" : null,
  customerType: role === "cliente" ? "private" : null,
});

const form = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};
const attackInput = () => form({ orderId: ORDER_ID, reason: "Motivo", customerId: OTHER_ID, userId: OTHER_ID, p_customer_id: OTHER_ID });

type AnyAction = (prev: object, fd: FormData) => Promise<unknown>;
const exported = (Object.entries(actions) as [string, unknown][]).filter((e): e is [string, AnyAction] => typeof e[1] === "function");

beforeEach(() => {
  state.events = [];
  state.cancelArgs = [];
});

describe("customer order Server Actions", () => {
  it("the file exports only the three actions (every export is a public endpoint)", () => {
    expect(Object.keys(actions).sort()).toEqual(["cancelPaid", "cancelUnpaid", "payNow"]);
  });

  const NON_CUSTOMERS: [string, AccountContext][] = [
    ["not signed in", { state: "anonymous" }],
    ["no profile", { state: "no_profile", userId: OTHER_ID }],
    ["padroncino", signedIn("padroncino")],
    ["admin", signedIn("admin")],
    ["blocked cliente", signedIn("cliente", true)],
  ];
  for (const [who, ctx] of NON_CUSTOMERS) {
    describe(who, () => {
      for (const [name, action] of exported) {
        it(`${name}: redirected, nothing reaches the service role, Stripe or the database`, async () => {
          state.ctx = ctx;
          await expect(action({}, attackInput())).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
          expect(state.events).toEqual([]);
        });
      }
    });
  }

  describe("cliente", () => {
    beforeEach(() => {
      state.ctx = signedIn("cliente");
    });

    it("cancelPaid: the customer id is the session's; the reason is trimmed", async () => {
      await expect(actions.cancelPaid({}, form({ orderId: ORDER_ID, reason: "  Motivo  ", customerId: OTHER_ID }))).rejects.toMatchObject({
        digest: expect.stringMatching(/^NEXT_REDIRECT/),
      });
      expect(state.cancelArgs).toHaveLength(1);
      expect(state.cancelArgs[0].slice(1)).toEqual([USER_ID, ORDER_ID, "Motivo"]);
    });

    it("cancelPaid: invalid order id or a too long reason never reach the server", async () => {
      expect(await actions.cancelPaid({}, form({ orderId: "nope" }))).toEqual({ error: "Ordine non valido." });
      expect(await actions.cancelPaid({}, form({ orderId: ORDER_ID, reason: "x".repeat(2001) }))).toMatchObject({ error: expect.any(String) });
      expect(state.events).toEqual([]);
    });
  });
});
