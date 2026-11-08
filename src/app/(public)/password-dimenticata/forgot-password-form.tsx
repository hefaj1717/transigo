"use client";

import { useActionState } from "react";
import { requestPasswordReset } from "@/lib/auth/actions";
import { initialFormState } from "@/lib/auth/form-state";
import { FormMessage, TextField } from "@/components/form-field";
import { SubmitButton } from "@/components/submit-button";

export function ForgotPasswordForm({ initialError }: { initialError?: string }) {
  const [state, action] = useActionState(requestPasswordReset, initialFormState);
  if (state.message) return <FormMessage success={state.message} />;
  const e = state.errors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage error={e._form ?? (state === initialFormState ? initialError : undefined)} />
      <TextField label="E-mail" name="email" type="email" autoComplete="email" defaultValue={state.values?.email} error={e.email} required />
      <SubmitButton>Invia link</SubmitButton>
    </form>
  );
}
