"use server";

// Account Server Actions (D42–D46). All input is validated here with zod; the browser is never trusted.
// redirect() throws, so it is always called outside try/catch.
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAppUrl } from "@/lib/supabase/env";
import { loadAccountContext } from "./account-context";
import { AUTH_MSG, authErrorMessage, isVatTakenError } from "./errors";
import { echoValues, type FormState } from "./form-state";
import { allowedNext, AREA_HOME, PATHS, resolveCompleteProfilePage, resolvePostSignIn, resolveResetPasswordPage, sanitizeNext } from "./routing";
import {
  carrierRegistrationSchema,
  customerProfileCompletionSchema,
  customerRegistrationSchema,
  existingCustomerProfileSchema,
  forgotPasswordSchema,
  formDataToObject,
  resetPasswordSchema,
  signInSchema,
  toFieldErrors,
} from "./schemas";
import { getAccountContext } from "./session";

const CHECK_EMAIL_PATH = `${PATHS.signUp}/controlla-email`;

/** Where links in auth e-mails point (template uses {{ .RedirectTo }}; see docs in the final setup steps). */
function confirmUrl() {
  return `${getAppUrl()}/auth/confirm`;
}

function logError(where: string, error: unknown) {
  // Log only technical details, never form values (personal data).
  const e = error as { code?: string; message?: string; status?: number } | null;
  console.error(`[auth] ${where}`, { code: e?.code, status: e?.status, message: e?.message });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

type RegistrationRequest = {
  role: "cliente" | "padroncino";
  email: string;
  password: string;
  metadata: { first_name: string; last_name: string; phone?: string };
  /** Inserts the customers / carriers row with the service role. */
  insertRoleRow: (service: SupabaseClient, profileId: string) => Promise<{ error: unknown }>;
  roleTable: "customers" | "carriers";
};

/**
 * Shared sign-up flow. Returns a FormState on error; on success returns null (caller redirects).
 * 1. sign up in Supabase Auth (trigger creates profiles with role from metadata, D37)
 * 2. insert customers/carriers and record consents (server only)
 * 3. on failure in step 2 delete the just-created auth user, so no half-registered account remains
 */
async function register(req: RegistrationRequest, values: Record<string, string>): Promise<FormState | null> {
  const fail = (errors: FormState["errors"]): FormState => ({ errors, values });
  const service = createServiceClient();

  const { data: settings, error: settingsError } = await service
    .from("settings")
    .select("terms_version, privacy_version")
    .single();
  if (settingsError || !settings) {
    logError("register: settings", settingsError);
    return fail({ _form: AUTH_MSG.generic });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: req.email,
    password: req.password,
    options: { emailRedirectTo: confirmUrl(), data: { role: req.role, ...req.metadata } },
  });
  if (error) {
    const message = authErrorMessage(error);
    if (message === AUTH_MSG.emailTaken) return fail({ email: message });
    if (message === AUTH_MSG.weakPassword) return fail({ password: message });
    if (message === AUTH_MSG.generic) logError("register: signUp", error);
    return fail({ _form: message });
  }

  const user = data.user;
  if (!user) return fail({ _form: AUTH_MSG.generic });
  // With e-mail confirmation on, an existing confirmed address returns a placeholder user without identities.
  if (user.identities?.length === 0) return fail({ email: AUTH_MSG.emailTaken });

  // Existing but unconfirmed account (Supabase re-sent the confirmation): never overwrite or delete it.
  const [{ data: profile }, { data: existingRow }] = await Promise.all([
    service.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    service.from(req.roleTable).select("profile_id").eq("profile_id", user.id).maybeSingle(),
  ]);
  if (!profile || profile.role !== req.role || existingRow) return fail({ email: AUTH_MSG.emailTaken });

  const rollback = async (where: string, err: unknown) => {
    logError(where, err);
    const { error: deleteError } = await service.auth.admin.deleteUser(user.id);
    if (deleteError) logError("register: rollback deleteUser", deleteError);
  };

  const { error: rowError } = await req.insertRoleRow(service, user.id);
  if (rowError) {
    await rollback(`register: insert ${req.roleTable}`, rowError);
    if (isVatTakenError(rowError as { code?: string; message?: string })) return fail({ vatNumber: AUTH_MSG.vatTaken });
    return fail({ _form: AUTH_MSG.generic });
  }

  const now = new Date().toISOString();
  const { error: consentError } = await service
    .from("profiles")
    .update({
      terms_accepted_at: now,
      terms_version: settings.terms_version,
      privacy_accepted_at: now,
      privacy_version: settings.privacy_version,
    })
    .eq("id", user.id);
  if (consentError) {
    await rollback("register: consents", consentError);
    return fail({ _form: AUTH_MSG.generic });
  }

  return null;
}

export async function registerCustomer(_prev: FormState, formData: FormData): Promise<FormState> {
  const input = formDataToObject(formData);
  const values = echoValues(input);
  const parsed = customerRegistrationSchema.safeParse(input);
  if (!parsed.success) return { errors: toFieldErrors(parsed.error), values };
  const d = parsed.data;

  const result = await register(
    {
      role: "cliente",
      email: d.email,
      password: d.password,
      metadata: { first_name: d.firstName, last_name: d.lastName, phone: d.phone },
      roleTable: "customers",
      insertRoleRow: async (service, profileId) =>
        service.from("customers").insert(
          d.customerType === "business"
            ? {
                profile_id: profileId,
                customer_type: "business",
                company_name: d.companyName,
                vat_number: d.vatNumber,
                sdi_code: d.sdiCode ?? null,
                pec: d.pec ?? null,
              }
            : { profile_id: profileId, customer_type: "private" }, // CF and billing address in "Riepilogo" (D43)
        ),
    },
    values,
  );
  if (result) return result;
  redirect(CHECK_EMAIL_PATH);
}

export async function registerCarrier(_prev: FormState, formData: FormData): Promise<FormState> {
  const input = formDataToObject(formData);
  const values = echoValues(input);
  const parsed = carrierRegistrationSchema.safeParse(input);
  if (!parsed.success) return { errors: toFieldErrors(parsed.error), values };
  const d = parsed.data;

  const result = await register(
    {
      role: "padroncino",
      email: d.email,
      password: d.password,
      metadata: { first_name: d.firstName, last_name: d.lastName, phone: d.phone },
      roleTable: "carriers",
      insertRoleRow: async (service, profileId) =>
        service.from("carriers").insert({
          profile_id: profileId, // status defaults to pending_review
          company_name: d.companyName,
          vat_number: d.vatNumber,
          fiscal_code: d.fiscalCode,
          hq_street: d.hqStreet,
          hq_city: d.hqCity,
          hq_postal_code: d.hqPostalCode,
          hq_province: d.hqProvince,
          sdi_code: d.sdiCode ?? null,
          pec: d.pec ?? null,
        }),
    },
    values,
  );
  if (result) return result;
  redirect(CHECK_EMAIL_PATH);
}

// ---------------------------------------------------------------------------
// Sign-in / sign-out
// ---------------------------------------------------------------------------

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const input = formDataToObject(formData);
  const values = { email: input.email ?? "", next: input.next ?? "" };
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) return { errors: toFieldErrors(parsed.error), values };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    const message = authErrorMessage(error);
    if (message === AUTH_MSG.generic) logError("signIn", error);
    return { errors: { _form: message }, values };
  }

  const ctx = await loadAccountContext(supabase, createServiceClient());
  redirect(resolvePostSignIn(ctx, input.next));
}

export async function signOut(formData?: FormData): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // Optional "next" (e.g. back to the booking wizard): same-origin paths only (open-redirect protection).
  const raw = formData?.get("next");
  const next = sanitizeNext(typeof raw === "string" ? raw : null);
  redirect(next ? `${PATHS.signIn}?next=${encodeURIComponent(next)}` : PATHS.signIn);
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export async function requestPasswordReset(_prev: FormState, formData: FormData): Promise<FormState> {
  const input = formDataToObject(formData);
  const values = { email: input.email ?? "" };
  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) return { errors: toFieldErrors(parsed.error), values };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: confirmUrl() });
  if (error) {
    const message = authErrorMessage(error);
    // Only rate limits are shown; anything else gets the neutral answer (no account enumeration).
    if (message === AUTH_MSG.rateLimited) return { errors: { _form: message }, values };
    logError("requestPasswordReset", error);
  }
  return {
    message: "Se l'indirizzo è registrato, riceverai a breve un'e-mail con il link per reimpostare la password.",
  };
}

export async function updatePassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await getAccountContext();
  const access = resolveResetPasswordPage(ctx);
  if (access.kind === "redirect") redirect(access.to);

  const parsed = resetPasswordSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    const message = authErrorMessage(error);
    if (message === AUTH_MSG.weakPassword || message === AUTH_MSG.samePassword) return { errors: { password: message } };
    if (message === AUTH_MSG.generic) logError("updatePassword", error);
    return { errors: { _form: message } };
  }
  redirect(resolvePostSignIn(ctx));
}

// ---------------------------------------------------------------------------
// Customer profile completion (D80)
// ---------------------------------------------------------------------------

/**
 * Completes a customer account that was created without the sign-up form (e.g. Supabase dashboard →
 * Add user → Auto Confirm User): customers row (only if missing — the type never changes), name, phone and
 * consents (D42). Everything is written by the server; then the user continues to `next` (panel or wizard).
 */
export async function completeCustomerProfile(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await getAccountContext();
  const input = formDataToObject(formData);
  const access = resolveCompleteProfilePage(ctx, input.next);
  if (access.kind === "redirect") redirect(access.to);
  if (ctx.state !== "signed_in") redirect(PATHS.signIn); // narrowed above; keeps TypeScript happy

  const values = echoValues(input);
  const service = createServiceClient();
  const hasCustomerRow = ctx.customerType !== null;

  const parsedProfile = existingCustomerProfileSchema.safeParse(input);
  const parsedNew = hasCustomerRow ? null : customerProfileCompletionSchema.safeParse(input);
  if (parsedNew && !parsedNew.success) return { errors: toFieldErrors(parsedNew.error), values };
  if (!parsedProfile.success) return { errors: toFieldErrors(parsedProfile.error), values };
  const d = parsedProfile.data;

  const { data: settings, error: settingsError } = await service.from("settings").select("terms_version, privacy_version").single();
  if (settingsError || !settings) {
    logError("completeProfile: settings", settingsError);
    return { errors: { _form: AUTH_MSG.generic }, values };
  }

  if (parsedNew?.success) {
    const c = parsedNew.data;
    const { error } = await service.from("customers").insert(
      c.customerType === "business"
        ? { profile_id: ctx.userId, customer_type: "business", company_name: c.companyName, vat_number: c.vatNumber, sdi_code: c.sdiCode ?? null, pec: c.pec ?? null }
        : { profile_id: ctx.userId, customer_type: "private" }, // CF and billing address in "Riepilogo" (D43)
    );
    if (error) {
      if (isVatTakenError(error)) return { errors: { vatNumber: AUTH_MSG.vatTaken }, values };
      logError("completeProfile: insert customers", error);
      return { errors: { _form: AUTH_MSG.generic }, values };
    }
  }

  const now = new Date().toISOString();
  const { error: profileError } = await service
    .from("profiles")
    .update({
      first_name: d.firstName,
      last_name: d.lastName,
      phone: d.phone ?? null,
      terms_accepted_at: now,
      terms_version: settings.terms_version,
      privacy_accepted_at: now,
      privacy_version: settings.privacy_version,
    })
    .eq("id", ctx.userId);
  if (profileError) {
    logError("completeProfile: update profiles", profileError);
    return { errors: { _form: AUTH_MSG.generic }, values };
  }

  redirect(allowedNext(ctx, input.next) ?? AREA_HOME.cliente);
}
