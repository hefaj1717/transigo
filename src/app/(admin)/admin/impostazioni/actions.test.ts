import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountContext } from "@/lib/auth/routing";

// Every "Impostazioni" Server Action refuses non-admins BEFORE any database access (session client or service role);
// an admin's save writes only the changed fields and an audit entry with the session's admin.

const session = vi.hoisted(() => ({ ctx: { state: "anonymous" } as AccountContext }));
const db = vi.hoisted(() => ({ calls: [] as string[], before: {} as Record<string, unknown>, updates: [] as Record<string, unknown>[] }));
const auditCalls = vi.hoisted(() => [] as unknown[][]);

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth/account-context", () => ({ loadAccountContext: async () => session.ctx }));
vi.mock("@/lib/supabase/env", () => ({ getAppUrl: () => "https://transigo.example" }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => { db.calls.push("service"); return {}; } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      db.calls.push(`from:${table}`);
      const q = {
        select: () => q,
        eq: () => q,
        single: async () => ({ data: db.before, error: null }),
        update: (patch: Record<string, unknown>) => {
          db.updates.push(patch);
          return { eq: () => ({ select: async () => ({ data: [{ id: true }], error: null }) }) };
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/admin/server", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin/server")>()),
  audit: vi.fn(async (...args: unknown[]) => { auditCalls.push(args); }),
}));

const actions = await import("./actions");

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const signedIn = (role: "admin" | "cliente" | "padroncino", isBlocked = false): AccountContext => ({
  state: "signed_in", userId: ADMIN_ID, email: "x@example.com", role, isBlocked, firstName: null,
  carrierStatus: role === "padroncino" ? "active" : null,
  customerProfile: role === "cliente" ? "complete" : null,
  customerType: role === "cliente" ? "private" : null,
});
const NON_ADMINS: [string, AccountContext][] = [
  ["not signed in", { state: "anonymous" }],
  ["no profile", { state: "no_profile", userId: "22222222-2222-4222-8222-222222222222" }],
  ["cliente", signedIn("cliente")],
  ["padroncino", signedIn("padroncino")],
  ["blocked admin", signedIn("admin", true)],
];

const fields = {
  company_name: "Transigo S.r.l.", company_vat_number: "12345678901", company_fiscal_code: "", company_street: "Via Roma 1", company_city: "Milano",
  company_postal_code: "20121", company_province: "mi", company_pec: "", company_sdi_code: "", company_email: "info@transigo.example", company_phone: "",
  free_cancellation_hours: "24", late_cancellation_fee_bp: "40", payout_window_hours: "24", unassigned_alert_hours: "4",
};
function form(): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

type AnyAction = (prev: object, fd: FormData) => Promise<{ error?: string; message?: string }>;
const exported = (Object.entries(actions) as [string, unknown][]).filter((e): e is [string, AnyAction] => typeof e[1] === "function");

beforeEach(() => {
  db.calls = [];
  db.updates = [];
  auditCalls.length = 0;
});

describe("Impostazioni Server Actions", () => {
  it("the file exports the expected actions", () => {
    expect(exported.map(([n]) => n).sort()).toEqual(["updateCompanyAction", "updateRulesAction"]);
  });

  for (const [who, ctx] of NON_ADMINS) {
    for (const [name, action] of exported) {
      it(`${who} — ${name}: redirected before any database access`, async () => {
        session.ctx = ctx;
        await expect(action({}, form())).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
        expect(db.calls.filter((c) => c.startsWith("from:"))).toEqual([]);
        expect(db.updates).toEqual([]);
      });
    }
  }

  it("admin: only changed company fields are written and audited", async () => {
    session.ctx = signedIn("admin");
    db.before = { company_name: "Transigo S.r.l.", company_vat_number: null, company_fiscal_code: null, company_street: "Via Roma 1", company_city: "Milano", company_postal_code: "20121", company_province: "MI", company_pec: null, company_sdi_code: null, company_email: null, company_phone: null };
    const r = await actions.updateCompanyAction({}, form());
    expect(r.message).toBe("Dati aziendali salvati.");
    expect(db.updates).toEqual([{ company_vat_number: "12345678901", company_email: "info@transigo.example" }]);
    expect(auditCalls[0][0]).toMatchObject({ userId: ADMIN_ID });
    expect(auditCalls[0][1]).toBe("settings.company");
  });

  it("admin: rules — percent stored as basis points, before/after in the audit; nothing changed → no write", async () => {
    session.ctx = signedIn("admin");
    db.before = { free_cancellation_hours: 24, late_cancellation_fee_bp: 5000, payout_window_hours: 24, unassigned_alert_hours: 4 };
    await actions.updateRulesAction({}, form());
    expect(db.updates).toEqual([{ late_cancellation_fee_bp: 4000 }]);
    expect(auditCalls[0][4]).toEqual({ before: { late_cancellation_fee_bp: 5000 }, after: { late_cancellation_fee_bp: 4000 } });

    db.updates = [];
    db.before = { free_cancellation_hours: 24, late_cancellation_fee_bp: 4000, payout_window_hours: 24, unassigned_alert_hours: 4 };
    expect((await actions.updateRulesAction({}, form())).message).toBe("Nessuna modifica.");
    expect(db.updates).toEqual([]);
  });

  it("admin: invalid input → message, no write", async () => {
    session.ctx = signedIn("admin");
    const fd = form();
    fd.set("company_postal_code", "123");
    expect((await actions.updateCompanyAction({}, fd)).error).toBe("Il CAP ha 5 cifre.");
    expect(db.updates).toEqual([]);
  });
});
