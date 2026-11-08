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
    .select("role, is_blocked, first_name, last_name, email, terms_accepted_at, privacy_accepted_at")
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

  // D80: a customer needs a customers row, a name and both consents (D42) before booking or using the panel.
  let customerProfile: "complete" | "incomplete" | null = null;
  let customerType: "private" | "business" | null = null;
  if (profile.role === "cliente") {
    const { data: customer, error: customerError } = await serviceClient
      .from("customers")
      .select("customer_type")
      .eq("profile_id", user.id)
      .maybeSingle();
    if (customerError) throw customerError;
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
    userId: user.id,
    email: profile.email as string,
    role: profile.role as Role,
    isBlocked: profile.is_blocked as boolean,
    firstName: (profile.first_name as string | null) ?? null,
    carrierStatus,
    customerProfile,
    customerType,
  };
}
