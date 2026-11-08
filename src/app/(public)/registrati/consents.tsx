import Link from "next/link";
import { CheckboxField, TextField } from "@/components/form-field";
import type { FieldErrors } from "@/lib/auth/schemas";

/** D42: two separate consents. */
export function Consents({ errors, values }: { errors: FieldErrors; values?: Record<string, string> }) {
  return (
    <div className="space-y-3 border-t border-zinc-200 pt-4">
      <CheckboxField
        name="acceptTerms"
        defaultChecked={values?.acceptTerms === "on"}
        error={errors.acceptTerms}
        label={<>Ho letto e accetto i <Link href="/termini" target="_blank" className="text-blue-700 underline">Termini e condizioni</Link> *</>}
      />
      <CheckboxField
        name="acceptPrivacy"
        defaultChecked={values?.acceptPrivacy === "on"}
        error={errors.acceptPrivacy}
        label={<>Ho letto l&apos;<Link href="/privacy" target="_blank" className="text-blue-700 underline">Informativa sulla privacy</Link> e acconsento al trattamento dei miei dati *</>}
      />
    </div>
  );
}

export function PasswordFields({ errors }: { errors: FieldErrors }) {
  return (
    <>
      <TextFieldPassword name="password" label="Password" error={errors.password} hint="Almeno 8 caratteri, con lettere e numeri." />
      <TextFieldPassword name="passwordConfirm" label="Ripeti la password" error={errors.passwordConfirm} />
    </>
  );
}

function TextFieldPassword(props: { name: string; label: string; error?: string; hint?: string }) {
  return <TextField {...props} type="password" autoComplete="new-password" required />;
}
