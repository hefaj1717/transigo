import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountContext } from "@/lib/auth/routing";
import { AUTH_MSG } from "@/lib/auth/errors";
import { PROFILE_MSG } from "@/lib/customers/profile";

// "Profilo" Server Actions. The real DAL (requireArea → routing) and the real zod schemas run; only the session
// loading and the Supabase clients are replaced by recorders. Checked: anyone who is not a customer never reaches
// the database or Auth; invalid input is refused before the database; the row is always the session's user (never
// an id from the form); the password is changed only after the current one was verified; no service role is used.

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

type Err = { code?: string; message?: string; status?: number } | null;

const state = vi.hoisted(() => ({
  ctx: { state: "anonymous" } as AccountContext,
  /** Ordered log: "update:<table>:<column>=<value>", "check:signIn", "check:signOut", "auth:updateUser", "service". */
  events: [] as string[],
  updates: [] as { table: string; values: Record<string, unknown> }[],
  updateResult: { data: [{ id: "x" }], error: null } as { data: unknown[] | null; error: Err },
  checkError: null as Err,
  updateUserError: null as Err,
}));

function fakeSessionClient() {
  return {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: (column: string, value: string) => ({
          select: async () => {
            state.events.push(`update:${table}:${column}=${value}`);
            state.updates.push({ table, values });
            return state.updateResult;
          },
        }),
      }),
    }),
    auth: {
      updateUser: async () => {
        state.events.push("auth:updateUser");
        return { data: {}, error: state.updateUserError };
      },
    },
  };
}

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/account-context", () => ({ loadAccountContext: async () => state.ctx }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSessionClient() }));
vi.mock("@/lib/supabase/env", () => ({ getSupabaseEnv: () => ({ url: "https://db.example", anonKey: "anon" }) }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => new Proxy({}, { get: () => { state.events.push("service"); throw new Error("no service role in Profilo"); } }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: async () => {
        state.events.push("check:signIn");
        return { data: {}, error: state.checkError };
      },
      signOut: async () => {
        state.events.push("check:signOut");
        return { error: null };
      },
    },
  }),
}));

const actions = await import("./actions");
const { updatePersonalData, updateBillingData, changePassword } = actions;

const signedIn = (role: "admin" | "cliente" | "padroncino", opts: { isBlocked?: boolean; customerType?: "private" | "business" } = {}): AccountContext => ({
  state: "signed_in", userId: USER_ID, email: "giulia@example.com", role, isBlocked: opts.isBlocked ?? false, firstName: null,
  carrierStatus: role === "padroncino" ? "active" : null,
  customerProfile: role === "cliente" ? "complete" : null,
  customerType: role === "cliente" ? (opts.customerType ?? "private") : null,
});

const form = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};

const address = { street: "Via Dante 12", city: "Milano", postalCode: "20121", province: "MI" };
/** Valid input for every action plus identity fields an attacker might add — they must never be used. */
const attackInput = () => form({
  firstName: "Giulia", lastName: "Conti", phone: "", fiscalCode: "RSSMRA85T10A562S", ...address,
  currentPassword: "vecchia123", password: "nuova12345", passwordConfirm: "nuova12345",
  userId: OTHER_ID, id: OTHER_ID, profile_id: OTHER_ID, customer_type: "business", customerType: "business", role: "admin",
});

type AnyAction = (prev: object, fd: FormData) => Promise<unknown>;
const exported = (Object.entries(actions) as [string, unknown][]).filter((e): e is [string, AnyAction] => typeof e[1] === "function");

beforeEach(() => {
  Object.assign(state, { events: [], updates: [], updateResult: { data: [{ id: "x" }], error: null }, checkError: null, updateUserError: null });
});

describe("Profilo Server Actions", () => {
  it("the file exports only the three actions (every export is a public endpoint)", () => {
    expect(Object.keys(actions).sort()).toEqual(["changePassword", "updateBillingData", "updatePersonalData"]);
  });

  const NON_CUSTOMERS: [string, AccountContext][] = [
    ["not signed in", { state: "anonymous" }],
    ["no profile", { state: "no_profile", userId: OTHER_ID }],
    ["padroncino", signedIn("padroncino")],
    ["admin", signedIn("admin")],
    ["blocked cliente", signedIn("cliente", { isBlocked: true })],
  ];
  for (const [who, ctx] of NON_CUSTOMERS) {
    describe(who, () => {
      for (const [name, action] of exported) {
        it(`${name}: redirected, nothing reaches the database or Auth`, async () => {
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

    it("updatePersonalData: own profile row only, editable columns only", async () => {
      const r = await updatePersonalData({}, attackInput());
      expect(r).toEqual({ message: PROFILE_MSG.saved });
      expect(state.events).toEqual([`update:profiles:id=${USER_ID}`]);
      expect(state.updates[0].values).toEqual({ first_name: "Giulia", last_name: "Conti", phone: null });
    });

    it("updatePersonalData: invalid input never reaches the database", async () => {
      const r = await updatePersonalData({}, form({ firstName: "", lastName: "Conti", phone: "12" }));
      expect(r).toMatchObject({ errors: { firstName: expect.any(String), phone: expect.any(String) } });
      expect(state.events).toEqual([]);
    });

    it("updatePersonalData: no row updated (RLS) → error, not success", async () => {
      state.updateResult = { data: [], error: null };
      expect(await updatePersonalData({}, attackInput())).toMatchObject({ errors: { _form: PROFILE_MSG.notSaved } });
    });

    it("updateBillingData: the type comes from the session, not from the form", async () => {
      const r = await updateBillingData({}, attackInput());
      expect(r).toEqual({ message: PROFILE_MSG.saved });
      expect(state.events).toEqual([`update:customers:profile_id=${USER_ID}`]);
      expect(state.updates[0].values).toEqual({
        fiscal_code: "RSSMRA85T10A562S", billing_street: "Via Dante 12", billing_city: "Milano", billing_postal_code: "20121", billing_province: "MI", billing_country: "IT",
      });
    });

    it("updateBillingData: business needs company data; a taken P.IVA is reported on the field", async () => {
      state.ctx = signedIn("cliente", { customerType: "business" });
      expect(await updateBillingData({}, attackInput())).toMatchObject({ errors: { companyName: expect.any(String) } });
      expect(state.events).toEqual([]);

      state.updateResult = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint customers_vat_number_key" } };
      const r = await updateBillingData({}, form({ companyName: "Conti Srl", vatNumber: "01234567897", sdiCode: "M5UXCR1", ...address }));
      expect(r).toMatchObject({ errors: { vatNumber: AUTH_MSG.vatTaken } });
    });

    it("changePassword: verifies the current password, then updates the session user", async () => {
      expect(await changePassword({}, attackInput())).toEqual({ message: PROFILE_MSG.passwordChanged });
      expect(state.events).toEqual(["check:signIn", "check:signOut", "auth:updateUser"]);
    });

    it("changePassword: a wrong current password never changes the password", async () => {
      state.checkError = { code: "invalid_credentials", message: "Invalid login credentials", status: 400 };
      expect(await changePassword({}, attackInput())).toEqual({ errors: { currentPassword: PROFILE_MSG.currentPasswordWrong } });
      expect(state.events).toEqual(["check:signIn"]);
    });

    it("changePassword: invalid input never reaches Auth", async () => {
      const r = await changePassword({}, form({ currentPassword: "vecchia123", password: "corta", passwordConfirm: "corta" }));
      expect(r).toMatchObject({ errors: { password: expect.any(String) } });
      expect(state.events).toEqual([]);
    });
  });
});
