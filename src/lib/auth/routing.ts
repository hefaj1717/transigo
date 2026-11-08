// Pure access rules for account areas (D46). No I/O: the server-only DAL (session.ts) builds the
// AccountContext and calls these functions; unit tests cover every role × area combination.

export type Role = "cliente" | "padroncino" | "admin";
export type CarrierStatus = "pending_review" | "active" | "rejected" | "suspended";
export type Area = Role;

export type AccountContext =
  | { state: "anonymous" }
  /** Authenticated in Supabase Auth but no profiles row (should not happen; trigger creates it). */
  | { state: "no_profile"; userId: string }
  | {
      state: "signed_in";
      userId: string;
      email: string;
      role: Role;
      isBlocked: boolean;
      firstName: string | null;
      /** Only for role padroncino; null when the carriers row is missing. */
      carrierStatus: CarrierStatus | null;
    };

export type Decision = { kind: "allow" } | { kind: "redirect"; to: string };

export const PATHS = {
  signIn: "/accedi",
  signUp: "/registrati",
  forgotPassword: "/password-dimenticata",
  resetPassword: "/reimposta-password",
  suspended: "/account-sospeso",
} as const;

export const AREA_HOME: Record<Area, string> = {
  cliente: "/cliente",
  padroncino: "/padroncino",
  admin: "/admin",
};

const allow: Decision = { kind: "allow" };
const redirect = (to: string): Decision => ({ kind: "redirect", to });

const NO_PROFILE_URL = `${PATHS.signIn}?errore=account`;

/** Where a signed-in account belongs (its panel, or the suspended page). */
export function homeFor(ctx: Extract<AccountContext, { state: "signed_in" }>): string {
  return ctx.isBlocked ? PATHS.suspended : AREA_HOME[ctx.role];
}

/** True if `path` is inside the panel of `area` (e.g. /cliente or /cliente/ordini). */
export function isInArea(path: string, area: Area): boolean {
  const home = AREA_HOME[area];
  return path === home || path.startsWith(`${home}/`);
}

/**
 * Accepts only a same-origin relative path ("/cliente/ordini?x=1"). Rejects absolute URLs,
 * protocol-relative "//host", backslashes and control characters (open-redirect protection).
 */
export function sanitizeNext(next: string | null | undefined): string | null {
  if (!next || next.length > 512) return null;
  if (!next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f]/.test(next)) return null;
  try {
    const url = new URL(next, "http://transigo.invalid");
    if (url.origin !== "http://transigo.invalid") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** Access to a panel page (/cliente/**, /padroncino/**, /admin/**). */
export function resolveAreaAccess(ctx: AccountContext, area: Area, currentPath?: string): Decision {
  if (ctx.state === "anonymous") {
    const next = sanitizeNext(currentPath) ?? AREA_HOME[area];
    return redirect(`${PATHS.signIn}?next=${encodeURIComponent(next)}`);
  }
  if (ctx.state === "no_profile") return redirect(NO_PROFILE_URL);
  if (ctx.isBlocked) return redirect(PATHS.suspended);
  if (ctx.role !== area) return redirect(AREA_HOME[ctx.role]);
  return allow;
}

/** Target after a successful sign-in or e-mail confirmation. `next` is honoured only inside the user's own panel. */
export function resolvePostSignIn(ctx: AccountContext, next?: string | null): string {
  if (ctx.state === "anonymous") return PATHS.signIn;
  if (ctx.state === "no_profile") return NO_PROFILE_URL;
  if (ctx.isBlocked) return PATHS.suspended;
  const safe = sanitizeNext(next);
  if (safe && isInArea(new URL(safe, "http://x").pathname, ctx.role)) return safe;
  return AREA_HOME[ctx.role];
}

/** Guest-only pages (/accedi, /registrati, /password-dimenticata): signed-in users go to their panel. */
export function resolveGuestPage(ctx: AccountContext): Decision {
  if (ctx.state === "signed_in") return redirect(homeFor(ctx));
  return allow; // anonymous, or no_profile (lets them sign in again / see the error)
}

/** /account-sospeso: only for blocked accounts. */
export function resolveSuspendedPage(ctx: AccountContext): Decision {
  if (ctx.state === "anonymous") return redirect(PATHS.signIn);
  if (ctx.state === "no_profile") return redirect(NO_PROFILE_URL);
  return ctx.isBlocked ? allow : redirect(AREA_HOME[ctx.role]);
}

/** /reimposta-password: needs the session created by the recovery link. */
export function resolveResetPasswordPage(ctx: AccountContext): Decision {
  if (ctx.state === "anonymous") return redirect(`${PATHS.forgotPassword}?errore=sessione`);
  if (ctx.state === "no_profile") return redirect(NO_PROFILE_URL);
  if (ctx.isBlocked) return redirect(PATHS.suspended);
  return allow;
}

/** What the carrier panel shows: full panel only for status active (D21 is checked separately for accepting jobs). */
export function carrierPanelView(ctx: Extract<AccountContext, { state: "signed_in" }>): "active" | "pending" {
  return ctx.carrierStatus === "active" ? "active" : "pending";
}
