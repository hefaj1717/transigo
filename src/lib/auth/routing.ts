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
      /**
       * Only for role cliente (D80): "incomplete" when the customers row, first/last name or the consents
       * (D42) are missing — e.g. an account created in the Supabase dashboard. null for other roles.
       */
      customerProfile: "complete" | "incomplete" | null;
      /** Only for role cliente with a customers row. */
      customerType: "private" | "business" | null;
    };

export type Decision = { kind: "allow" } | { kind: "redirect"; to: string };

export const PATHS = {
  signIn: "/accedi",
  signUp: "/registrati",
  forgotPassword: "/password-dimenticata",
  resetPassword: "/reimposta-password",
  suspended: "/account-sospeso",
  completeProfile: "/completa-profilo", // D80
  booking: "/prenota", // booking wizard (public, D70)
} as const;

export const AREA_HOME: Record<Area, string> = {
  cliente: "/cliente",
  padroncino: "/padroncino",
  admin: "/admin",
};

const allow: Decision = { kind: "allow" };
const redirect = (to: string): Decision => ({ kind: "redirect", to });

const NO_PROFILE_URL = `${PATHS.signIn}?errore=account`;

type SignedIn = Extract<AccountContext, { state: "signed_in" }>;

const needsProfile = (ctx: SignedIn) => ctx.role === "cliente" && ctx.customerProfile === "incomplete";

/** "/completa-profilo?next=…" (D80). */
export function completeProfileUrl(next: string): string {
  return `${PATHS.completeProfile}?next=${encodeURIComponent(next)}`;
}

/** Where a signed-in account belongs (its panel, the profile completion page or the suspended page). */
export function homeFor(ctx: SignedIn): string {
  if (ctx.isBlocked) return PATHS.suspended;
  if (needsProfile(ctx)) return completeProfileUrl(AREA_HOME.cliente);
  return AREA_HOME[ctx.role];
}

/** True if `path` is the booking wizard (/prenota, /prenota?…). */
export function isBookingPath(path: string): boolean {
  return path === PATHS.booking || path.startsWith(`${PATHS.booking}/`);
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
  if (needsProfile(ctx)) return redirect(completeProfileUrl(sanitizeNext(currentPath) ?? AREA_HOME.cliente));
  return allow;
}

/**
 * The `next` target a signed-in account may go to: a page in its own panel or, for customers, the booking
 * wizard (D70). Anything else → null.
 */
export function allowedNext(ctx: SignedIn, next?: string | null): string | null {
  const safe = sanitizeNext(next);
  if (!safe) return null;
  const path = new URL(safe, "http://x").pathname;
  if (isInArea(path, ctx.role)) return safe;
  if (ctx.role === "cliente" && isBookingPath(path)) return safe;
  return null;
}

/**
 * Target after a successful sign-in or e-mail confirmation. `next` is honoured only inside the user's own
 * panel or (customers) the booking wizard. A customer with an incomplete profile goes through
 * /completa-profilo first and then on to the same target (D80).
 */
export function resolvePostSignIn(ctx: AccountContext, next?: string | null): string {
  if (ctx.state === "anonymous") return PATHS.signIn;
  if (ctx.state === "no_profile") return NO_PROFILE_URL;
  if (ctx.isBlocked) return PATHS.suspended;
  const target = allowedNext(ctx, next) ?? AREA_HOME[ctx.role];
  return needsProfile(ctx) ? completeProfileUrl(target) : target;
}

/**
 * Guest-only pages (/accedi, /registrati, /password-dimenticata): signed-in users go where they would go
 * after signing in (their panel, or an allowed `next` such as the booking wizard).
 */
export function resolveGuestPage(ctx: AccountContext, next?: string | null): Decision {
  if (ctx.state === "signed_in") return redirect(resolvePostSignIn(ctx, next));
  return allow; // anonymous, or no_profile (lets them sign in again / see the error)
}

/** /completa-profilo (D80): only for a signed-in customer whose profile is incomplete. */
export function resolveCompleteProfilePage(ctx: AccountContext, next?: string | null): Decision {
  if (ctx.state === "anonymous") return redirect(`${PATHS.signIn}?next=${encodeURIComponent(PATHS.completeProfile)}`);
  if (ctx.state === "no_profile") return redirect(NO_PROFILE_URL);
  if (ctx.isBlocked) return redirect(PATHS.suspended);
  if (ctx.role !== "cliente") return redirect(AREA_HOME[ctx.role]);
  if (!needsProfile(ctx)) return redirect(allowedNext(ctx, next) ?? AREA_HOME.cliente);
  return allow;
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
export function carrierPanelView(ctx: SignedIn): "active" | "pending" {
  return ctx.carrierStatus === "active" ? "active" : "pending";
}
