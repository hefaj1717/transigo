"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signIn } from "@/lib/auth/actions";
import { initialFormState } from "@/lib/auth/form-state";
import { FormMessage, TextField } from "@/components/form-field";
import { SubmitButton } from "@/components/submit-button";

export function LoginForm({ next, initialError }: { next: string; initialError?: string }) {
  const [state, action] = useActionState(signIn, initialFormState);
  const e = state.errors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage error={e._form ?? (state === initialFormState ? initialError : undefined)} />
      <input type="hidden" name="next" value={next} />
      <TextField label="E-mail" name="email" type="email" autoComplete="email" defaultValue={state.values?.email} error={e.email} required />
      <TextField label="Password" name="password" type="password" autoComplete="current-password" error={e.password} required />
      <div className="text-right text-sm">
        <Link href="/password-dimenticata" className="text-blue-700 underline">Password dimenticata?</Link>
      </div>
      <SubmitButton>Accedi</SubmitButton>
    </form>
  );
}
