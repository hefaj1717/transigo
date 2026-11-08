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
  const { data: { user } } = await userClient.auth.getUser(); // verifies the token with Supabase Auth
  if (!user) return { state: "anonymous" };

  const { data: profile, error } = await serviceClient
    .from("profiles")
    .select("role, is_blocked, first_name, email")
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!profile) return { state: "no_profile", userId: user.id };

  let carrierStatus: CarrierStatus | null = null;
  if (profile.role === "padroncino") {
    const { data: carrier, error: carrierError } = await serviceClient
      .from("carriers")
      .select("status")
      .eq("profile_id", user.id)
      .maybeSingle();
    if (carrierError) throw carrierError;
    carrierStatus = (carrier?.status as CarrierStatus | undefined) ?? null;
  }

  return {
    state: "signed_in",
    userId: user.id,
    email: profile.email as string,
    role: profile.role as Role,
    isBlocked: profile.is_blocked as boolean,
    firstName: (profile.first_name as string | null) ?? null,
    carrierStatus,
  };
}
