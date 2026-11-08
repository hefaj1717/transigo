"use client";

import { useActionState } from "react";
import { updatePassword } from "@/lib/auth/actions";
import { initialFormState } from "@/lib/auth/form-state";
import { FormMessage, TextField } from "@/components/form-field";
import { SubmitButton } from "@/components/submit-button";

export function ResetPasswordForm() {
  const [state, action] = useActionState(updatePassword, initialFormState);
  const e = state.errors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage error={e._form} />
      <TextField label="Nuova password" name="password" type="password" autoComplete="new-password" error={e.password} required hint="Almeno 8 caratteri, con lettere e numeri." />
      <TextField label="Ripeti la nuova password" name="passwordConfirm" type="password" autoComplete="new-password" error={e.passwordConfirm} required />
      <SubmitButton>Salva la nuova password</SubmitButton>
    </form>
  );
}
