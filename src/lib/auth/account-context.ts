// Builds the AccountContext used by the routing rules (routing.ts).
// Takes the clients as arguments so it can be tested against the real database (tests/rls/account-context.test.ts);
// the request-bound wrapper lives in session.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountContext, CarrierStatus, Role } from "./routing";

/**
 * @param userClient  client acting as the signed-in user (session cookies / access token)
 * @param serviceClient service-role client. Needed because a blocked account cannot read its own
 *                      profile through RLS (auth_role() is null), so "blocked" and "no profile" would look the same.
 *                      Reads are limited to the id returned by Supabase Auth for the current session.
 */
export async function loadAccountContext(
  userClient: SupabaseClient,
  serviceClient: SupabaseClient,
): Promise<AccountContext> {
  // getClaims() verifies the access token locally against the project's JWKS (asymmetric signing keys, cached per
  // instance) — no round trip to Supabase Auth on every request (D184). With symmetric keys (local stack) it falls
  // back to getUser(). Blocking still takes effect immediately: the profile below is read on every request.
  const { data: claimsData } = await userClient.auth.getClaims();
  const userId = typeof claimsData?.claims?.sub === "string" ? claimsData.claims.sub : null;
  if (!userId) return { state: "anonymous" };

  // One query: profile + the role's own row (both keyed by profile_id, one-to-one).
  const { data: profile, error } = await serviceClient
    .from("profiles")
    .select("role, is_blocked, first_name, last_name, email, terms_accepted_at, privacy_accepted_at, customers!profile_id(customer_type), carriers!profile_id(status)")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!profile) return { state: "no_profile", userId };
  const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

  let carrierStatus: CarrierStatus | null = null;
  if (profile.role === "padroncino") {
    const carrier = one(profile.carriers as { status: string } | { status: string }[] | null);
    carrierStatus = (carrier?.status as CarrierStatus | undefined) ?? null;
  }

  // D80: a customer needs a customers row, a name and both consents (D42) before booking or using the panel.
  let customerProfile: "complete" | "incomplete" | null = null;
  let customerType: "private" | "business" | null = null;
  if (profile.role === "cliente") {
    const customer = one(profile.customers as { customer_type: string } | { customer_type: string }[] | null);
    customerType = (customer?.customer_type as "private" | "business" | undefined) ?? null;
    const complete =
      !!customer &&
      !!profile.first_name?.trim() &&
      !!profile.last_name?.trim() &&
      !!profile.terms_accepted_at &&
      !!profile.privacy_accepted_at;
    customerProfile = complete ? "complete" : "incomplete";
  }

  return {
    state: "signed_in",
    userId,
    email: profile.email as string,
    role: profile.role as Role,
    isBlocked: profile.is_blocked as boolean,
    firstName: (profile.first_name as string | null) ?? null,
    carrierStatus,
    customerProfile,
    customerType,
  };
}
