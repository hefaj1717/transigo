"use client";

import { useActionState } from "react";
import Link from "next/link";
import { resendConfirmation, signIn } from "@/lib/auth/actions";
import { initialFormState } from "@/lib/auth/form-state";
import { FormMessage, TextField } from "@/components/form-field";
import { SubmitButton } from "@/components/submit-button";

export function LoginForm({ next, initialError }: { next: string; initialError?: string }) {
  const [state, action] = useActionState(signIn, initialFormState);
  const e = state.errors ?? {};
  return (
    <div className="space-y-4">
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
      {state.emailNotConfirmed && state.values?.email ? <ResendConfirmation key={state.values.email} email={state.values.email} /> : null}
    </div>
  );
}

/** Separate form (forms can't be nested): resends the confirmation link to the address just used. */
function ResendConfirmation({ email }: { email: string }) {
  const [state, action, pending] = useActionState(resendConfirmation, initialFormState);
  if (state.message) return <FormMessage success={state.message} />;
  return (
    <form action={action} className="space-y-2">
      <FormMessage error={state.errors?._form ?? state.errors?.email} />
      <input type="hidden" name="email" value={email} />
      <button type="submit" disabled={pending} className="w-full rounded-md border border-blue-600 px-4 py-2 font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60">
        {pending ? "Invio in corso…" : "Invia di nuovo l'e-mail di conferma"}
      </button>
    </form>
  );
}
