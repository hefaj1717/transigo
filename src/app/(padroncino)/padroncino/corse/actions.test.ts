import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountContext, CarrierStatus } from "@/lib/auth/routing";
import { JOB_MSG, JOB_PATHS } from "@/lib/carriers/jobs";

// The carrier job Server Actions ("Accetta la Corsa", "Rinuncia"). The real DAL (requireArea → routing), the
// real zod schemas and the real jobs-server.ts run; only the session loading, the Supabase clients and the
// e-mail senders are replaced by recorders. Checked: anyone who is not an allowed carrier never reaches an RPC,
// a query or the service role; invalid forms are refused before the database; the carrier is always the
// session's; the service role is used only after a successful RPC; only Italian JOB_MSG texts come back.

const CARRIER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const VEHICLE_ID = "44444444-4444-4444-8444-444444444444";

type Result = { data: unknown; error: { code?: string; message?: string; details?: string } | null };

const state = vi.hoisted(() => ({
  ctx: { state: "anonymous" } as AccountContext,
  /** Ordered log: "rpc:<fn>", "from:<table>", "service:<prop>", "mail:<what>". */
  events: [] as string[],
  rpcCalls: [] as { fn: string; args: unknown }[],
  eqCalls: [] as [string, unknown][],
  createClientCalls: 0,
  rpcResult: {} as Record<string, Result>,
  tableResult: {} as Record<string, Result>,
  rpcThrows: null as Error | null,
}));

const mail = vi.hoisted(() => ({
  sendOrderAssignedEmail: vi.fn<(db: unknown, orderId: string, appUrl: string) => Promise<void>>(async () => {}),
  sendEmail: vi.fn(async () => true),
}));

function fakeSessionClient() {
  const query = (table: string) => {
    const chain: Record<string, unknown> = {};
    const done = async () => state.tableResult[table] ?? { data: null, error: null };
    for (const m of ["select", "in", "order"]) chain[m] = () => chain;
    chain.eq = (col: string, val: unknown) => {
      state.eqCalls.push([`${table}.${col}`, val]);
      return chain;
    };
    chain.maybeSingle = done;
    chain.single = done;
    chain.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => done().then(res, rej);
    return chain;
  };
  return {
    rpc: (fn: string, args?: unknown) => {
      state.events.push(`rpc:${fn}`);
      state.rpcCalls.push({ fn, args });
      if (state.rpcThrows) throw state.rpcThrows;
      const done = async () => state.rpcResult[fn] ?? { data: null, error: { code: "XX000", message: "unexpected" } };
      return { single: done, then: (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => done().then(res, rej) };
    },
    from: (table: string) => {
      state.events.push(`from:${table}`);
      return query(table);
    },
  };
}

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/account-context", () => ({ loadAccountContext: async () => state.ctx }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    state.createClientCalls++;
    return fakeSessionClient();
  },
}));
vi.mock("@/lib/supabase/env", () => ({ getAppUrl: () => "https://transigo.example" }));
// Records every USE of a service-role client (the DAL creates one for its session loader — mocked, never used).
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () =>
    new Proxy({}, { get: (_t, prop) => { state.events.push(`service:${String(prop)}`); return () => ({}); } }),
}));
vi.mock("@/lib/orders/customer-emails", () => ({
  sendOrderAssignedEmail: (db: { marker?: unknown }, orderId: string, appUrl: string) => {
    void db.marker; // touching the service client records its use
    state.events.push("mail:order_assigned");
    return mail.sendOrderAssignedEmail(db, orderId, appUrl);
  },
}));
vi.mock("@/lib/notifications/email", () => ({
  sendEmail: (db: { marker?: unknown }) => {
    void db.marker;
    state.events.push("mail:carrier_released_job");
    return mail.sendEmail();
  },
}));

const { revalidatePath } = await import("next/cache");
const actions = await import("./actions");

const signedIn = (role: "admin" | "cliente" | "padroncino", opts: { isBlocked?: boolean; carrierStatus?: CarrierStatus | null } = {}): AccountContext => ({
  state: "signed_in", userId: CARRIER_ID, email: "x@example.com", role, isBlocked: opts.isBlocked ?? false, firstName: null,
  carrierStatus: role === "padroncino" ? (opts.carrierStatus === undefined ? "active" : opts.carrierStatus) : null,
  customerProfile: role === "cliente" ? "complete" : null,
  customerType: role === "cliente" ? "private" : null,
});

function form(fields: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
/** A valid form plus identity fields an attacker might add — they must never be used. */
const attackForm = () =>
  form({ orderId: ORDER_ID, vehicleId: VEHICLE_ID, carrierId: OTHER_ID, carrier_id: OTHER_ID, userId: OTHER_ID, p_carrier_id: OTHER_ID });

type AnyAction = (prev: null, fd: FormData) => Promise<unknown>;
const exported = (Object.entries(actions) as [string, unknown][]).filter((e): e is [string, AnyAction] => typeof e[1] === "function");
const { acceptJobAction, releaseJobAction } = actions;

const nothingReachedTheDatabase = () => {
  expect(state.rpcCalls).toEqual([]);
  expect(state.events).toEqual([]);
  expect(mail.sendOrderAssignedEmail).not.toHaveBeenCalled();
  expect(mail.sendEmail).not.toHaveBeenCalled();
};

const ALL_JOB_MSGS = new Set<string>(Object.values(JOB_MSG));

beforeEach(() => {
  Object.assign(state, { events: [], rpcCalls: [], eqCalls: [], createClientCalls: 0, rpcResult: {}, tableResult: {}, rpcThrows: null });
  mail.sendOrderAssignedEmail.mockClear();
  mail.sendEmail.mockClear();
  vi.mocked(revalidatePath).mockClear();
  process.env.ADMIN_NOTIFICATION_EMAIL = "ops@transigo.example";
});

describe("carrier job Server Actions", () => {
  it("the file exports only acceptJobAction and releaseJobAction (every export is a public endpoint)", () => {
    expect(Object.keys(actions).sort()).toEqual(["acceptJobAction", "releaseJobAction"]);
    expect(exported).toHaveLength(2);
  });

  const NON_CARRIERS: [string, AccountContext][] = [
    ["not signed in", { state: "anonymous" }],
    ["no profile", { state: "no_profile", userId: OTHER_ID }],
    ["cliente", signedIn("cliente")],
    ["admin", signedIn("admin")],
    ["blocked padroncino", signedIn("padroncino", { isBlocked: true })],
  ];

  for (const [who, ctx] of NON_CARRIERS) {
    describe(who, () => {
      for (const [name, action] of exported) {
        it(`${name}: redirected, nothing reaches an RPC, a query or the service role`, async () => {
          state.ctx = ctx;
          await expect(action(null, attackForm())).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
          nothingReachedTheDatabase();
          expect(revalidatePath).not.toHaveBeenCalled();
        });
      }
    });
  }

  // A padroncino who may not use the action: refused from the SESSION status, before any database call.
  const REFUSED: [string, CarrierStatus | null, AnyAction, string][] = [
    ["pending_review", "pending_review", acceptJobAction, JOB_MSG.notEligible],
    ["pending_review", "pending_review", releaseJobAction, JOB_MSG.forbidden],
    ["rejected", "rejected", acceptJobAction, JOB_MSG.notEligible],
    ["rejected", "rejected", releaseJobAction, JOB_MSG.forbidden],
    ["without carriers row", null, acceptJobAction, JOB_MSG.notEligible],
    ["without carriers row", null, releaseJobAction, JOB_MSG.forbidden],
    ["suspended (D116)", "suspended", acceptJobAction, JOB_MSG.notEligible],
  ];
  for (const [who, status, action, message] of REFUSED) {
    it(`padroncino ${who}: ${action.name} refused before the database`, async () => {
      state.ctx = signedIn("padroncino", { carrierStatus: status });
      expect(await action(null, attackForm())).toMatchObject({ ok: false, error: message });
      nothingReachedTheDatabase();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }

  it("suspended padroncino may still release its own job (D116) — the database decides", async () => {
    state.ctx = signedIn("padroncino", { carrierStatus: "suspended" });
    state.rpcResult.release_job = { data: null, error: { code: "55000", details: "too_late", message: "release_job: too late" } };
    expect(await releaseJobAction(null, attackForm())).toMatchObject({ ok: false, error: JOB_MSG.releaseTooLate, tooLate: true });
    expect(state.rpcCalls).toEqual([{ fn: "release_job", args: { p_order_id: ORDER_ID } }]);
  });

  describe("invalid forms are refused before anything reaches the database", () => {
    const BAD_ACCEPT: [string, Record<string, string>, string][] = [
      ["empty form", {}, JOB_MSG.notFound],
      ["missing vehicleId", { orderId: ORDER_ID }, JOB_MSG.chooseVehicle],
      ["missing orderId", { vehicleId: VEHICLE_ID }, JOB_MSG.notFound],
      ["orderId not a uuid", { orderId: "1 or 1=1", vehicleId: VEHICLE_ID }, JOB_MSG.notFound],
      ["vehicleId not a uuid", { orderId: ORDER_ID, vehicleId: "abc" }, JOB_MSG.chooseVehicle],
      ["orderId with extra text", { orderId: `${ORDER_ID}x`, vehicleId: VEHICLE_ID }, JOB_MSG.notFound],
      ["empty strings", { orderId: "", vehicleId: "" }, JOB_MSG.notFound],
    ];
    for (const [what, fields, message] of BAD_ACCEPT) {
      it(`acceptJobAction: ${what}`, async () => {
        state.ctx = signedIn("padroncino");
        expect(await acceptJobAction(null, form(fields))).toMatchObject({ ok: false, error: message });
        nothingReachedTheDatabase();
      });
    }
    const BAD_RELEASE: [string, Record<string, string>][] = [
      ["empty form", {}],
      ["orderId not a uuid", { orderId: "../admin" }],
      ["only a carrierId", { carrierId: OTHER_ID }],
    ];
    for (const [what, fields] of BAD_RELEASE) {
      it(`releaseJobAction: ${what}`, async () => {
        state.ctx = signedIn("padroncino");
        expect(await releaseJobAction(null, form(fields))).toMatchObject({ ok: false, error: JOB_MSG.notAssigned });
        nothingReachedTheDatabase();
      });
    }
  });

  describe("active padroncino", () => {
    beforeEach(() => {
      state.ctx = signedIn("padroncino");
    });

    it("accept: RPC with the carrier's session and only order + vehicle; service role only after it; e-mail id read back for the session carrier", async () => {
      state.rpcResult.accept_job = { data: [{ assigned_at: "2026-11-09T10:00:00Z", newly_assigned: true }], error: null };
      state.tableResult.orders = { data: { id: ORDER_ID }, error: null };

      expect(await acceptJobAction(null, attackForm())).toMatchObject({
        ok: true, newlyAssigned: true, message: JOB_MSG.accepted, href: JOB_PATHS.my_job(ORDER_ID),
      });
      expect(state.rpcCalls).toEqual([{ fn: "accept_job", args: { p_order_id: ORDER_ID, p_vehicle_id: VEHICLE_ID } }]);
      // Identity filters only ever use the session's id, never the form's.
      expect(state.eqCalls.filter(([c]) => c.endsWith("carrier_id"))).toEqual([["orders.carrier_id", CARRIER_ID]]);
      expect(JSON.stringify(state.rpcCalls)).not.toContain(OTHER_ID);
      // Session RPC → read back → service role (for the outbox) → e-mail.
      const firstService = state.events.findIndex((e) => e.startsWith("service:"));
      expect(state.events.indexOf("rpc:accept_job")).toBe(0);
      expect(firstService).toBeGreaterThan(state.events.indexOf("from:orders"));
      expect(mail.sendOrderAssignedEmail).toHaveBeenCalledTimes(1);
      expect(mail.sendOrderAssignedEmail.mock.calls[0][1]).toBe(ORDER_ID);
      expect(revalidatePath).toHaveBeenCalledWith(JOB_PATHS.available);
      expect(revalidatePath).toHaveBeenCalledWith(JOB_PATHS.mine);
    });

    it("accept: same carrier again → «già accettata da te», no e-mail, no service role", async () => {
      state.rpcResult.accept_job = { data: [{ assigned_at: "2026-11-09T10:00:00Z", newly_assigned: false }], error: null };
      expect(await acceptJobAction(null, attackForm())).toMatchObject({ ok: true, newlyAssigned: false, message: JOB_MSG.alreadyMine });
      expect(state.events.some((e) => e.startsWith("service:"))).toBe(false);
      expect(mail.sendOrderAssignedEmail).not.toHaveBeenCalled();
    });

    it("accept: already taken → D120 text + refresh the list; no service role", async () => {
      state.rpcResult.accept_job = { data: null, error: { code: "55000", details: "already_taken", message: "accept_job: already taken" } };
      expect(await acceptJobAction(null, attackForm())).toMatchObject({ ok: false, error: JOB_MSG.alreadyTaken, refreshList: true });
      expect(state.events.some((e) => e.startsWith("service:"))).toBe(false);
      expect(revalidatePath).toHaveBeenCalledWith(JOB_PATHS.available);
    });

    it("accept: the read-back finds no order for this carrier → no e-mail (the accept still stands)", async () => {
      state.rpcResult.accept_job = { data: [{ assigned_at: "2026-11-09T10:00:00Z", newly_assigned: true }], error: null };
      state.tableResult.orders = { data: null, error: null };
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await acceptJobAction(null, attackForm())).toMatchObject({ ok: true, newlyAssigned: true });
      expect(mail.sendOrderAssignedEmail).not.toHaveBeenCalled();
      expect(state.events.some((e) => e.startsWith("service:"))).toBe(false);
    });

    it("release: RPC with only the order id; admin e-mail through the service role after it", async () => {
      state.tableResult.orders = {
        data: { order_number: "TG-1", assigned_at: "2026-11-09T10:00:00Z", order_legs: [{ leg_index: 0, pickup_window_start: "2026-11-20T08:00:00Z", pickup_window_end: "2026-11-20T10:00:00Z" }] },
        error: null,
      };
      state.tableResult.carriers = { data: { company_name: "Rossi Trasporti" }, error: null };
      state.rpcResult.release_job = { data: { released_at: "2026-11-09T10:05:00Z", order_number: "TG-1" }, error: null };

      expect(await releaseJobAction(null, attackForm())).toMatchObject({ ok: true, message: JOB_MSG.released, href: "/padroncino/le-mie-corse?esito=rinuncia" });
      expect(state.rpcCalls).toEqual([{ fn: "release_job", args: { p_order_id: ORDER_ID } }]);
      expect(state.eqCalls.filter(([c]) => c.endsWith("carrier_id") || c.endsWith("profile_id")).every(([, v]) => v === CARRIER_ID)).toBe(true);
      const firstService = state.events.findIndex((e) => e.startsWith("service:"));
      expect(firstService).toBeGreaterThan(state.events.indexOf("rpc:release_job"));
      expect(mail.sendEmail).toHaveBeenCalledTimes(1);
      expect(revalidatePath).toHaveBeenCalledWith(JOB_PATHS.mine);
    });

    it("database errors never reach the browser: unknown code, thrown error → JOB_MSG only", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const secret = 'relation "public.orders" violates policy orders_select_carrier';
      state.rpcResult.accept_job = { data: null, error: { code: "XX000", message: secret, details: secret } };
      state.rpcResult.release_job = { data: null, error: { code: "P0001", message: secret, details: secret } };
      const results = [await acceptJobAction(null, attackForm()), await releaseJobAction(null, attackForm())];
      state.rpcThrows = new Error(secret);
      results.push(await acceptJobAction(null, attackForm()), await releaseJobAction(null, attackForm()));
      for (const r of results) {
        expect(JSON.stringify(r)).not.toContain("orders");
        expect(r).toMatchObject({ ok: false });
        expect(ALL_JOB_MSGS.has((r as { error: string }).error)).toBe(true);
      }
      expect(state.events.some((e) => e.startsWith("service:"))).toBe(false);
    });
  });
});
