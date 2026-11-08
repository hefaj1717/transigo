import { describe, expect, it } from "vitest";
import {
  AREA_HOME,
  carrierPanelView,
  allowedNext,
  resolveAreaAccess,
  resolveCompleteProfilePage,
  resolveGuestPage,
  resolvePostSignIn,
  resolveResetPasswordPage,
  resolveSuspendedPage,
  sanitizeNext,
  type AccountContext,
  type Area,
  type CarrierStatus,
  type Role,
} from "./routing";

type SignedIn = Extract<AccountContext, { state: "signed_in" }>;

const user = (role: Role, extra: Partial<SignedIn> = {}): SignedIn => ({
  state: "signed_in",
  userId: `id-${role}`,
  email: `${role}@example.com`,
  role,
  isBlocked: false,
  firstName: "Test",
  carrierStatus: role === "padroncino" ? "active" : null,
  customerProfile: role === "cliente" ? "complete" : null,
  customerType: role === "cliente" ? "private" : null,
  ...extra,
});

const anonymous: AccountContext = { state: "anonymous" };
const noProfile: AccountContext = { state: "no_profile", userId: "x" };
const areas: Area[] = ["cliente", "padroncino", "admin"];
const carrierStatuses: CarrierStatus[] = ["pending_review", "active", "rejected", "suspended"];

describe("each role reaches only its own panel", () => {
  const accounts: [string, SignedIn][] = [
    ["cliente", user("cliente")],
    ["admin", user("admin")],
    ...carrierStatuses.map((s): [string, SignedIn] => [`padroncino (${s})`, user("padroncino", { carrierStatus: s })]),
    ["padroncino without carriers row", user("padroncino", { carrierStatus: null })],
  ];

  for (const [label, ctx] of accounts) {
    for (const area of areas) {
      const expected = area === ctx.role ? { kind: "allow" } : { kind: "redirect", to: AREA_HOME[ctx.role] };
      it(`${label} → /${area}: ${expected.kind === "allow" ? "allowed" : `redirect to ${AREA_HOME[ctx.role]}`}`, () => {
        expect(resolveAreaAccess(ctx, area, `/${area}`)).toEqual(expected);
      });
    }
  }

  it("admin is not allowed into the cliente or padroncino panel (no super-access via routing)", () => {
    expect(resolveAreaAccess(user("admin"), "cliente")).toEqual({ kind: "redirect", to: "/admin" });
    expect(resolveAreaAccess(user("admin"), "padroncino")).toEqual({ kind: "redirect", to: "/admin" });
  });
});

describe("anonymous, blocked and broken accounts", () => {
  for (const area of areas) {
    it(`anonymous → /${area} redirects to /accedi with next`, () => {
      expect(resolveAreaAccess(anonymous, area, `/${area}/x?y=1`)).toEqual({
        kind: "redirect",
        to: `/accedi?next=${encodeURIComponent(`/${area}/x?y=1`)}`,
      });
    });
    for (const role of ["cliente", "padroncino", "admin"] as Role[]) {
      it(`blocked ${role} → /${area} redirects to /account-sospeso`, () => {
        expect(resolveAreaAccess(user(role, { isBlocked: true }), area)).toEqual({ kind: "redirect", to: "/account-sospeso" });
      });
    }
    it(`user without profile → /${area} redirects to /accedi?errore=account`, () => {
      expect(resolveAreaAccess(noProfile, area)).toEqual({ kind: "redirect", to: "/accedi?errore=account" });
    });
  }
  it("anonymous with an unsafe path falls back to the area home in next", () => {
    expect(resolveAreaAccess(anonymous, "cliente", "//evil.com")).toEqual({ kind: "redirect", to: "/accedi?next=%2Fcliente" });
  });
});

describe("carrier panel view (only active sees the full panel)", () => {
  for (const s of [...carrierStatuses, null]) {
    it(`${s ?? "no carriers row"} → ${s === "active" ? "active" : "pending"}`, () => {
      expect(carrierPanelView(user("padroncino", { carrierStatus: s }))).toBe(s === "active" ? "active" : "pending");
    });
  }
});

describe("after sign-in", () => {
  it("goes to the role's panel", () => {
    expect(resolvePostSignIn(user("cliente"))).toBe("/cliente");
    expect(resolvePostSignIn(user("padroncino", { carrierStatus: "pending_review" }))).toBe("/padroncino");
    expect(resolvePostSignIn(user("admin"))).toBe("/admin");
  });
  it("honours next only inside the user's own panel", () => {
    expect(resolvePostSignIn(user("cliente"), "/cliente/ordini?f=1")).toBe("/cliente/ordini?f=1");
    expect(resolvePostSignIn(user("cliente"), "/admin")).toBe("/cliente");
    expect(resolvePostSignIn(user("cliente"), "/clienteX")).toBe("/cliente");
    expect(resolvePostSignIn(user("padroncino"), "/cliente")).toBe("/padroncino");
    expect(resolvePostSignIn(user("admin"), "https://evil.com/admin")).toBe("/admin");
  });
  it("blocked account goes to /account-sospeso, even with next", () => {
    expect(resolvePostSignIn(user("cliente", { isBlocked: true }), "/cliente")).toBe("/account-sospeso");
  });
});

describe("guest-only and special pages", () => {
  it("signed-in users skip /accedi and /registrati", () => {
    expect(resolveGuestPage(user("cliente"))).toEqual({ kind: "redirect", to: "/cliente" });
    expect(resolveGuestPage(user("admin"))).toEqual({ kind: "redirect", to: "/admin" });
    expect(resolveGuestPage(user("padroncino", { isBlocked: true }))).toEqual({ kind: "redirect", to: "/account-sospeso" });
    expect(resolveGuestPage(anonymous)).toEqual({ kind: "allow" });
  });
  it("/account-sospeso is only for blocked accounts", () => {
    expect(resolveSuspendedPage(user("cliente", { isBlocked: true }))).toEqual({ kind: "allow" });
    expect(resolveSuspendedPage(user("cliente"))).toEqual({ kind: "redirect", to: "/cliente" });
    expect(resolveSuspendedPage(anonymous)).toEqual({ kind: "redirect", to: "/accedi" });
  });
  it("/reimposta-password needs a (recovery) session", () => {
    expect(resolveResetPasswordPage(user("padroncino"))).toEqual({ kind: "allow" });
    expect(resolveResetPasswordPage(anonymous)).toEqual({ kind: "redirect", to: "/password-dimenticata?errore=sessione" });
    expect(resolveResetPasswordPage(user("cliente", { isBlocked: true }))).toEqual({ kind: "redirect", to: "/account-sospeso" });
  });
});

describe("sanitizeNext (open redirect protection)", () => {
  it("keeps relative paths with query and hash", () => {
    expect(sanitizeNext("/cliente/ordini?f=1#x")).toBe("/cliente/ordini?f=1#x");
  });
  it("rejects absolute, protocol-relative and tricky URLs", () => {
    for (const v of ["https://evil.com", "//evil.com", "/\\evil.com", "\\\\evil.com", "javascript:alert(1)", "cliente", "", null, undefined, "/a\nb"]) {
      expect(sanitizeNext(v as string), String(v)).toBeNull();
    }
  });
  it("normalizes dot segments", () => {
    expect(sanitizeNext("/cliente/../admin")).toBe("/admin");
  });
});

describe("customer profile completion (D80)", () => {
  const incomplete = user("cliente", { customerProfile: "incomplete", customerType: null });

  it("after sign-in an incomplete customer goes to /completa-profilo, keeping the target", () => {
    expect(resolvePostSignIn(incomplete)).toBe("/completa-profilo?next=%2Fcliente");
    expect(resolvePostSignIn(incomplete, "/prenota?passo=contatti")).toBe(`/completa-profilo?next=${encodeURIComponent("/prenota?passo=contatti")}`);
    expect(resolvePostSignIn(incomplete, "/admin")).toBe("/completa-profilo?next=%2Fcliente");
  });

  it("the customer panel sends an incomplete customer to /completa-profilo with the current page", () => {
    expect(resolveAreaAccess(incomplete, "cliente", "/cliente/ordini")).toEqual({ kind: "redirect", to: "/completa-profilo?next=%2Fcliente%2Fordini" });
    expect(resolveAreaAccess(incomplete, "admin")).toEqual({ kind: "redirect", to: "/cliente" });
  });

  it("guest pages send an incomplete customer to /completa-profilo too", () => {
    expect(resolveGuestPage(incomplete, "/prenota")).toEqual({ kind: "redirect", to: "/completa-profilo?next=%2Fprenota" });
  });

  it("/completa-profilo: only an incomplete customer stays; a complete one continues to next", () => {
    expect(resolveCompleteProfilePage(incomplete, "/prenota")).toEqual({ kind: "allow" });
    expect(resolveCompleteProfilePage(user("cliente"), "/prenota?passo=contatti")).toEqual({ kind: "redirect", to: "/prenota?passo=contatti" });
    expect(resolveCompleteProfilePage(user("cliente"), "https://evil.example")).toEqual({ kind: "redirect", to: "/cliente" });
    expect(resolveCompleteProfilePage(user("padroncino"))).toEqual({ kind: "redirect", to: "/padroncino" });
    expect(resolveCompleteProfilePage(user("admin"))).toEqual({ kind: "redirect", to: "/admin" });
    expect(resolveCompleteProfilePage(user("cliente", { isBlocked: true, customerProfile: "incomplete" }))).toEqual({ kind: "redirect", to: "/account-sospeso" });
    expect(resolveCompleteProfilePage(anonymous)).toEqual({ kind: "redirect", to: "/accedi?next=%2Fcompleta-profilo" });
    expect(resolveCompleteProfilePage(noProfile).kind).toBe("redirect");
  });
});

describe("next to the booking wizard (D70)", () => {
  it("customers may return to /prenota after sign-in; other roles may not", () => {
    expect(resolvePostSignIn(user("cliente"), "/prenota?passo=account")).toBe("/prenota?passo=account");
    expect(resolvePostSignIn(user("padroncino"), "/prenota")).toBe("/padroncino");
    expect(resolvePostSignIn(user("admin"), "/prenota")).toBe("/admin");
    expect(allowedNext(user("cliente"), "/prenotazioni")).toBeNull();
    expect(allowedNext(user("cliente"), "//evil.example/prenota")).toBeNull();
  });

  it("a signed-in customer opening /accedi?next=/prenota goes straight back to the wizard", () => {
    expect(resolveGuestPage(user("cliente"), "/prenota")).toEqual({ kind: "redirect", to: "/prenota" });
  });
});
