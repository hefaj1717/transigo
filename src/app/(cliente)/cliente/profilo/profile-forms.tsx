"use client";

import { useActionState } from "react";
import { FormMessage, TextField } from "@/components/form-field";
import { SubmitButton } from "@/components/submit-button";
import { initialFormState } from "@/lib/auth/form-state";
import { changePassword, updateBillingData, updatePersonalData } from "./actions";

export function PersonalForm({ initial }: { initial: { firstName: string; lastName: string; phone: string } }) {
  const [state, action] = useActionState(updatePersonalData, initialFormState);
  const v: Record<string, string> = state.values ?? initial;
  const e = state.errors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage error={e._form} success={state.message} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Nome" name="firstName" autoComplete="given-name" defaultValue={v.firstName} error={e.firstName} required maxLength={80} />
        <TextField label="Cognome" name="lastName" autoComplete="family-name" defaultValue={v.lastName} error={e.lastName} required maxLength={80} />
      </div>
      <TextField label="Telefono" name="phone" type="tel" autoComplete="tel" defaultValue={v.phone} error={e.phone} hint="Facoltativo." />
      <div className="sm:w-48">
        <SubmitButton pendingText="Salvataggio…">Salva</SubmitButton>
      </div>
    </form>
  );
}

export function BillingForm({ customerType, initial }: { customerType: "private" | "business"; initial: Record<string, string> }) {
  const [state, action] = useActionState(updateBillingData, initialFormState);
  const v: Record<string, string> = state.values ?? initial;
  const e = state.errors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage error={e._form} success={state.message} />
      {customerType === "business" ? (
        <>
          <TextField label="Ragione sociale" name="companyName" autoComplete="organization" defaultValue={v.companyName} error={e.companyName} required maxLength={160} />
          <TextField label="Partita IVA" name="vatNumber" defaultValue={v.vatNumber} error={e.vatNumber} required maxLength={16} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Codice destinatario SDI" name="sdiCode" defaultValue={v.sdiCode} error={e.sdiCode} maxLength={7} />
            <TextField label="PEC" name="pec" type="email" defaultValue={v.pec} error={e.pec} />
          </div>
          <p className="text-xs text-zinc-500">Per la fattura elettronica indica almeno il codice SDI oppure la PEC.</p>
        </>
      ) : (
        <TextField label="Codice fiscale" name="fiscalCode" defaultValue={v.fiscalCode} error={e.fiscalCode} required maxLength={16} />
      )}
      <TextField label="Indirizzo" name="street" autoComplete="street-address" defaultValue={v.street} error={e.street} required maxLength={160} placeholder="Via e numero civico" />
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem_6rem]">
        <TextField label="Città" name="city" autoComplete="address-level2" defaultValue={v.city} error={e.city} required maxLength={80} />
        <TextField label="CAP" name="postalCode" autoComplete="postal-code" inputMode="numeric" defaultValue={v.postalCode} error={e.postalCode} required maxLength={5} />
        <TextField label="Provincia" name="province" defaultValue={v.province} error={e.province} required maxLength={2} placeholder="MI" />
      </div>
      <div className="sm:w-48">
        <SubmitButton pendingText="Salvataggio…">Salva</SubmitButton>
      </div>
    </form>
  );
}

export function PasswordForm() {
  const [state, action] = useActionState(changePassword, initialFormState);
  const e = state.errors ?? {};
  return (
    // key: after a successful change the fields are cleared (the form is remounted).
    <form key={state.message ?? "form"} action={action} className="space-y-4" noValidate>
      <FormMessage error={e._form} success={state.message} />
      <TextField label="Password attuale" name="currentPassword" type="password" autoComplete="current-password" error={e.currentPassword} required />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Nuova password" name="password" type="password" autoComplete="new-password" error={e.password} required hint="Almeno 8 caratteri, con lettere e numeri." />
        <TextField label="Ripeti la nuova password" name="passwordConfirm" type="password" autoComplete="new-password" error={e.passwordConfirm} required />
      </div>
      <div className="sm:w-48">
        <SubmitButton pendingText="Aggiornamento…">Cambia password</SubmitButton>
      </div>
    </form>
  );
}
