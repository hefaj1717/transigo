"use server";

import { revalidatePath } from "next/cache";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { AUTH_MSG, authErrorMessage, isVatTakenError } from "@/lib/auth/errors";
import { echoValues, type FormState } from "@/lib/auth/form-state";
import { formDataToObject, toFieldErrors } from "@/lib/auth/schemas";
import { requireArea } from "@/lib/auth/session";
import { billingRow, billingSchemaFor, changePasswordSchema, personalDataRow, personalDataSchema, PROFILE_MSG } from "@/lib/customers/profile";
import { getSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

// "Profilo" Server Actions (spec 7). Every action starts with the DAL (requireArea), and writes only with the
// customer's own session: RLS limits the row to auth.uid() and the column grants to the editable fields. The
// user id always comes from the session, never from the form. No service role here.

const PATH = "/cliente/profilo";

function logError(where: string, error: unknown) {
  // Technical details only, never form values (personal data).
  const e = error as { code?: string; message?: string; status?: number } | null;
  console.error(`[profilo] ${where}`, { code: e?.code, status: e?.status, message: e?.message });
}

/** Nome, cognome, telefono (profiles). */
export async function updatePersonalData(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireArea("cliente", PATH);
  const input = formDataToObject(formData);
  const parsed = personalDataSchema.safeParse(input);
  if (!parsed.success) return { errors: toFieldErrors(parsed.error), values: echoValues(input) };

  const supabase = await createClient();
  const { data, error } = await supabase.from("profiles").update(personalDataRow(parsed.data)).eq("id", ctx.userId).select("id");
  if (error || !data?.length) {
    logError("updatePersonalData", error);
    return { errors: { _form: PROFILE_MSG.notSaved }, values: echoValues(input) };
  }
  revalidatePath(PATH);
  return { message: PROFILE_MSG.saved };
}

/** Default billing data (customers, D36): used to prefill "Riepilogo". Orders keep their own snapshot. */
export async function updateBillingData(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireArea("cliente", PATH);
  const input = formDataToObject(formData);
  const type = ctx.customerType;
  if (!type) return { errors: { _form: PROFILE_MSG.notSaved } };
  const parsed = billingSchemaFor(type).safeParse(input);
  if (!parsed.success) return { errors: toFieldErrors(parsed.error), values: echoValues(input) };

  const supabase = await createClient();
  const { data, error } = await supabase.from("customers").update(billingRow(type, parsed.data)).eq("profile_id", ctx.userId).select("profile_id");
  if (error && isVatTakenError(error)) return { errors: { vatNumber: AUTH_MSG.vatTaken }, values: echoValues(input) };
  if (error || !data?.length) {
    logError("updateBillingData", error);
    return { errors: { _form: PROFILE_MSG.notSaved }, values: echoValues(input) };
  }
  revalidatePath(PATH);
  return { message: PROFILE_MSG.saved };
}

/**
 * Password change: the current password is checked first with a separate, cookie-less client (its session is
 * signed out right after), then the new one is set on the customer's own session.
 */
export async function changePassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireArea("cliente", PATH);
  const parsed = changePasswordSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const { url, anonKey } = getSupabaseEnv();
  const check = createPlainClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: checkError } = await check.auth.signInWithPassword({ email: ctx.email, password: parsed.data.currentPassword });
  if (checkError) {
    const message = authErrorMessage(checkError);
    if (message === AUTH_MSG.rateLimited) return { errors: { _form: message } };
    if (message !== AUTH_MSG.invalidCredentials) logError("changePassword: check", checkError);
    return { errors: { currentPassword: PROFILE_MSG.currentPasswordWrong } };
  }
  await check.auth.signOut({ scope: "local" }).catch(() => {});

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    const message = authErrorMessage(error);
    if (message === AUTH_MSG.weakPassword || message === AUTH_MSG.samePassword) return { errors: { password: message } };
    if (message === AUTH_MSG.generic) logError("changePassword", error);
    return { errors: { _form: message } };
  }
  return { message: PROFILE_MSG.passwordChanged };
}
