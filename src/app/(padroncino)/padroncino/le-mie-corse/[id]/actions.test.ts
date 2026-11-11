import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountContext, CarrierStatus } from "@/lib/auth/routing";
import { EXEC_MSG } from "@/lib/carriers/execution";

// Job execution Server Actions. The real DAL (requireArea → routing), the real zod schemas and the real
// execution-server.ts run; only the session loading, the Supabase clients and the e-mail sender are replaced by
// recorders. Checked: anyone who is not an allowed carrier never reaches an RPC, Storage or the service role;
// invalid input is refused before the database; identity fields in the input are ignored; the service role is
// used only after a successful RPC; an e-mail failure does not undo the delivery. The real database paths are
// in tests/rls/carrier-execution-server.test.ts.

const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const PHOTO_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID = "55555555-5555-4555-8555-555555555555";
const PHOTO_PATH = `${ORDER_ID}/${FILE_ID}.jpg`;
const SIG_PATH = `${ORDER_ID}/${FILE_ID}.png`;

type Result = { data: unknown; error: { code?: string; message?: string; details?: string; statusCode?: string } | null };

const state = vi.hoisted(() => ({
  ctx: { state: "anonymous" } as AccountContext,
  /** Ordered log: "rpc:<fn>", "storage:<bucket>:<op>", "service:<what>", "mail:order_delivered". */
  events: [] as string[],
  rpcCalls: [] as { fn: string; args: unknown }[],
  rpcResult: {} as Record<string, Result>,
  signResult: null as Result | null,
  mailThrows: false,
}));

function fakeSessionClient() {
  return {
    rpc: (fn: string, args?: unknown) => {
      state.events.push(`rpc:${fn}`);
      state.rpcCalls.push({ fn, args });
      const done = async () => state.rpcResult[fn] ?? { data: null, error: { code: "XX000", message: "unexpected" } };
      return { single: done, then: (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => done().then(res, rej) };
    },
    from: (table: string) => {
      state.events.push(`from:${table}`);
      throw new Error("no table reads expected");
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUploadUrl: async (path: string) => {
          state.events.push(`storage:${bucket}:sign`);
          return state.signResult ?? { data: { path, token: "tok" }, error: null };
        },
      }),
    },
  };
}

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/account-context", () => ({ loadAccountContext: async () => state.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSessionClient() }));
vi.mock("@/lib/supabase/env", () => ({ getAppUrl: () => "https://transigo.example" }));
vi.mock("@/lib/supabase/service", () => ({
  // Records every USE (the DAL creates one for its session loader — mocked, never used).
  createServiceClient: () => {
    return {
      storage: {
        from: (bucket: string) => ({
          remove: async (paths: string[]) => {
            state.events.push(`service:${bucket}:remove:${paths.join(",")}`);
            return { data: [], error: null };
          },
        }),
      },
    };
  },
}));
vi.mock("@/lib/orders/customer-emails", () => ({
  sendOrderDeliveredEmail: async (db: { storage?: unknown }, orderId: string) => {
    if (db.storage) state.events.push("service:mail");
    state.events.push(`mail:order_delivered:${orderId}`);
    if (state.mailThrows) throw new Error("smtp down");
  },
}));

const { revalidatePath } = await import("next/cache");
const actions = await import("./actions");

const signedIn = (role: "admin" | "cliente" | "padroncino", opts: { isBlocked?: boolean; carrierStatus?: CarrierStatus | null } = {}): AccountContext => ({
  state: "signed_in", userId: OTHER_ID, email: "x@example.com", role, isBlocked: opts.isBlocked ?? false, firstName: null,
  carrierStatus: role === "padroncino" ? (opts.carrierStatus === undefined ? "active" : opts.carrierStatus) : null,
  customerProfile: role === "cliente" ? "complete" : null,
  customerType: role === "cliente" ? "private" : null,
});

/** A valid input for every action plus identity fields an attacker might add — they must never be used. */
const attackInput = () => ({
  orderId: ORDER_ID, legIndex: 0, step: "arrived_pickup", kind: "pickup", path: PHOTO_PATH, photoId: PHOTO_ID,
  recipientName: "Lucia", signaturePath: SIG_PATH,
  carrierId: OTHER_ID, carrier_id: OTHER_ID, userId: OTHER_ID, p_carrier_id: OTHER_ID, uploaded_by: OTHER_ID,
});

type AnyAction = (input: unknown) => Promise<unknown>;
const exported = (Object.entries(actions) as [string, unknown][]).filter((e): e is [string, AnyAction] => typeof e[1] === "function");
const {
  recordStepAction, createPhotoUploadAction, registerPhotoAction, deletePhotoAction, createSignatureUploadAction, completeDeliveryAction,
} = actions;

const EXPECTED_EXPORTS = [
  "completeDeliveryAction", "createPhotoUploadAction", "createSignatureUploadAction", "deletePhotoAction", "recordStepAction", "registerPhotoAction",
];

const nothingReachedTheDatabase = () => {
  expect(state.rpcCalls).toEqual([]);
  expect(state.events).toEqual([]);
};

beforeEach(() => {
  Object.assign(state, { events: [], rpcCalls: [], rpcResult: {}, signResult: null, mailThrows: false });
  vi.mocked(revalidatePath).mockClear();
});

describe("job execution Server Actions", () => {
  it("the file exports only the six actions (every export is a public endpoint)", () => {
    expect(Object.keys(actions).sort()).toEqual(EXPECTED_EXPORTS);
    expect(exported).toHaveLength(EXPECTED_EXPORTS.length);
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
        it(`${name}: redirected, nothing reaches an RPC, Storage or the service role`, async () => {
          state.ctx = ctx;
          await expect(action(attackInput())).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
          nothingReachedTheDatabase();
          expect(revalidatePath).not.toHaveBeenCalled();
        });
      }
    });
  }

  for (const status of ["pending_review", "rejected", null] as const) {
    for (const [name, action] of exported) {
      it(`padroncino ${status ?? "without carriers row"}: ${name} refused from the session status`, async () => {
        state.ctx = signedIn("padroncino", { carrierStatus: status });
        expect(await action(attackInput())).toEqual({ ok: false, message: EXEC_MSG.forbidden, refresh: false });
        nothingReachedTheDatabase();
      });
    }
  }

  it("suspended padroncino executes its accepted jobs (D116) — the database decides", async () => {
    state.ctx = signedIn("padroncino", { carrierStatus: "suspended" });
    state.rpcResult.carrier_record_step = { data: { recorded_at: "2026-11-11T09:00:00Z", newly_recorded: true, order_status: "assigned" }, error: null };
    expect(await recordStepAction(attackInput())).toMatchObject({ ok: true, newlyRecorded: true });
    expect(state.rpcCalls).toEqual([
      { fn: "carrier_record_step", args: { p_order_id: ORDER_ID, p_leg_index: 0, p_step: "arrived_pickup", p_lat: null, p_lng: null } },
    ]);
  });

  describe("invalid input never reaches the database", () => {
    const BAD: [string, AnyAction, unknown, string][] = [
      ["recordStep: no input", recordStepAction, undefined, EXEC_MSG.forbidden],
      ["recordStep: unknown step", recordStepAction, { orderId: ORDER_ID, legIndex: 0, step: "teleported" }, EXEC_MSG.forbidden],
      ["recordStep: orderId not a uuid", recordStepAction, { orderId: "1 or 1=1", legIndex: 0, step: "loaded" }, EXEC_MSG.forbidden],
      ["recordStep: negative leg", recordStepAction, { orderId: ORDER_ID, legIndex: -1, step: "loaded" }, EXEC_MSG.forbidden],
      ["recordStep: lat as text", recordStepAction, { orderId: ORDER_ID, legIndex: 0, step: "loaded", lat: "45" }, EXEC_MSG.forbidden],
      ["photo upload: unknown kind", createPhotoUploadAction, { orderId: ORDER_ID, legIndex: 0, kind: "claim" }, EXEC_MSG.forbidden],
      ["photo upload: path of another order", createPhotoUploadAction, { orderId: ORDER_ID, legIndex: 0, kind: "pickup", path: `${OTHER_ID}/${FILE_ID}.jpg` }, EXEC_MSG.photoInvalid],
      ["photo upload: path traversal", createPhotoUploadAction, { orderId: ORDER_ID, legIndex: 0, kind: "pickup", path: `${ORDER_ID}/../x.jpg` }, EXEC_MSG.photoInvalid],
      ["register: missing path", registerPhotoAction, { orderId: ORDER_ID, legIndex: 0, kind: "pickup" }, EXEC_MSG.forbidden],
      ["delete: photoId not a uuid", deletePhotoAction, { photoId: "x" }, EXEC_MSG.forbidden],
      ["signature upload: .jpg path", createSignatureUploadAction, { orderId: ORDER_ID, path: PHOTO_PATH }, EXEC_MSG.signature],
      ["POD: empty name", completeDeliveryAction, { orderId: ORDER_ID, recipientName: "   ", signaturePath: SIG_PATH }, EXEC_MSG.recipientName],
      ["POD: no signature", completeDeliveryAction, { orderId: ORDER_ID, recipientName: "Lucia" }, EXEC_MSG.signatureEmpty],
      ["POD: signature of another order", completeDeliveryAction, { orderId: ORDER_ID, recipientName: "Lucia", signaturePath: `${OTHER_ID}/${FILE_ID}.png` }, EXEC_MSG.signature],
    ];
    for (const [what, action, input, message] of BAD) {
      it(what, async () => {
        state.ctx = signedIn("padroncino");
        expect(await action(input)).toMatchObject({ ok: false, message });
        nothingReachedTheDatabase();
      });
    }
  });

  it("identity fields in the input are ignored: only the session's RPC arguments go out", async () => {
    state.ctx = signedIn("padroncino");
    state.rpcResult.register_order_photo = { data: { photo_id: PHOTO_ID, newly_registered: true }, error: null };
    await registerPhotoAction(attackInput());
    expect(state.rpcCalls).toEqual([
      { fn: "register_order_photo", args: { p_order_id: ORDER_ID, p_leg_index: 0, p_kind: "pickup", p_storage_path: PHOTO_PATH } },
    ]);
  });

  it("photo upload: a new path inside the order folder, signed with the session; a retry that had arrived → alreadyUploaded", async () => {
    state.ctx = signedIn("padroncino");
    const r = await createPhotoUploadAction({ orderId: ORDER_ID, legIndex: 0, kind: "pickup" });
    expect(r).toMatchObject({ ok: true, token: "tok", alreadyUploaded: false, path: expect.stringMatching(new RegExp(`^${ORDER_ID}/[0-9a-f-]{36}\\.jpg$`)) });
    expect(state.events).toEqual(["storage:order-photos:sign"]);

    state.signResult = { data: null, error: { statusCode: "409", message: "The resource already exists" } };
    expect(await createPhotoUploadAction({ orderId: ORDER_ID, legIndex: 0, kind: "pickup", path: PHOTO_PATH }))
      .toEqual({ ok: true, path: PHOTO_PATH, token: null, signedUrl: null, alreadyUploaded: true });

    state.signResult = { data: null, error: { statusCode: "403", message: "new row violates row-level security policy" } };
    expect(await createSignatureUploadAction({ orderId: ORDER_ID })).toEqual({ ok: false, message: EXEC_MSG.notInProgress, refresh: true });
    expect(state.events.some((e) => e.startsWith("service:"))).toBe(false);
  });

  it("database errors become Italian texts; nothing else reaches the browser", async () => {
    state.ctx = signedIn("padroncino");
    state.rpcResult.carrier_record_step = { data: null, error: { code: "55000", details: "wrong_step:0:loaded", message: "carrier_record_step: not the next step" } };
    expect(await recordStepAction({ orderId: ORDER_ID, legIndex: 0, step: "departed" })).toEqual({ ok: false, message: EXEC_MSG.wrongStep, refresh: true });
    expect(revalidatePath).toHaveBeenCalledWith(`/padroncino/le-mie-corse/${ORDER_ID}`);
    state.rpcResult.register_order_photo = { data: null, error: { code: "XX000", message: "relation secret_table does not exist" } };
    expect(await registerPhotoAction({ orderId: ORDER_ID, legIndex: 0, kind: "pickup", path: PHOTO_PATH }))
      .toEqual({ ok: false, message: EXEC_MSG.generic, refresh: false });
  });

  it("delete: the service role removes only the path the RPC returned, and only after it", async () => {
    state.ctx = signedIn("padroncino");
    state.rpcResult.delete_order_photo = { data: null, error: { code: "55000", details: "step_closed", message: "x" } };
    expect(await deletePhotoAction({ photoId: PHOTO_ID })).toMatchObject({ ok: false, message: EXEC_MSG.stepClosed });
    expect(state.events).toEqual(["rpc:delete_order_photo"]);

    state.events = [];
    state.rpcResult.delete_order_photo = { data: PHOTO_PATH, error: null };
    expect(await deletePhotoAction({ photoId: PHOTO_ID, path: `${OTHER_ID}/x.jpg` })).toMatchObject({ ok: true });
    expect(state.events).toEqual(["rpc:delete_order_photo", `service:order-photos:remove:${PHOTO_PATH}`]);

    state.events = [];
    state.rpcResult.delete_order_photo = { data: null, error: null }; // already deleted (double tap)
    expect(await deletePhotoAction({ photoId: PHOTO_ID })).toMatchObject({ ok: true });
    expect(state.events).toEqual(["rpc:delete_order_photo"]);
  });

  it("POD: e-mail only after a successful complete_delivery; an e-mail error does not undo the delivery", async () => {
    state.ctx = signedIn("padroncino");
    const pod = { orderId: ORDER_ID, recipientName: " Lucia Bianchi ", signaturePath: SIG_PATH, lat: 45.1, lng: 9.2 };

    state.rpcResult.complete_delivery = { data: null, error: { code: "55000", details: "steps_missing", message: "x" } };
    expect(await completeDeliveryAction(pod)).toEqual({ ok: false, message: EXEC_MSG.stepsMissing, refresh: true });
    expect(state.events).toEqual(["rpc:complete_delivery"]);

    state.events = [];
    state.rpcCalls = [];
    state.mailThrows = true;
    state.rpcResult.complete_delivery = { data: { delivered_at: "2026-11-11T10:00:00Z", newly_delivered: true }, error: null };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await completeDeliveryAction(pod)).toEqual({ ok: true, message: EXEC_MSG.delivered, newlyDelivered: true });
    expect(state.rpcCalls).toEqual([
      { fn: "complete_delivery", args: { p_order_id: ORDER_ID, p_recipient_name: "Lucia Bianchi", p_signature_path: SIG_PATH, p_lat: 45.1, p_lng: 9.2 } },
    ]);
    expect(state.events).toEqual(["rpc:complete_delivery", "service:mail", `mail:order_delivered:${ORDER_ID}`]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("order_delivered e-mail failed"), expect.objectContaining({ orderId: ORDER_ID }));
    errors.mockRestore();
    expect(revalidatePath).toHaveBeenCalledWith(`/cliente/ordini/${ORDER_ID}`);
  });
});
