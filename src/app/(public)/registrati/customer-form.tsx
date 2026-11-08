"use client";

import { useActionState, useState } from "react";
import { registerCustomer } from "@/lib/auth/actions";
import { initialFormState } from "@/lib/auth/form-state";
import { FormMessage, TextField } from "@/components/form-field";
import { SubmitButton } from "@/components/submit-button";
import { Consents, PasswordFields } from "./consents";

// D43 (privato: no codice fiscale here — collected in "Riepilogo") and D44 (azienda: ragione sociale, P.IVA, SDI or PEC).
export function CustomerForm() {
  const [state, action] = useActionState(registerCustomer, initialFormState);
  const [type, setType] = useState<"private" | "business">(
    state.values?.customerType === "business" ? "business" : "private",
  );
  const e = state.errors ?? {};
  const v = state.values ?? {};

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage error={e._form} />

      <fieldset>
        <legend className="text-sm font-medium text-zinc-800">Sei un privato o un&apos;azienda? *</legend>
        <div className="mt-2 flex gap-4">
          {(["private", "business"] as const).map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm">
              <input type="radio" name="customerType" value={t} checked={type === t} onChange={() => setType(t)} />
              {t === "private" ? "Privato" : "Azienda"}
            </label>
          ))}
        </div>
        {e.customerType ? <p className="mt-1 text-sm text-red-600">{e.customerType}</p> : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Nome" name="firstName" autoComplete="given-name" defaultValue={v.firstName} error={e.firstName} required maxLength={80} />
        <TextField label="Cognome" name="lastName" autoComplete="family-name" defaultValue={v.lastName} error={e.lastName} required maxLength={80} />
      </div>

      {type === "business" ? (
        <div className="space-y-4 rounded-md bg-zinc-50 p-4">
          <TextField label="Ragione sociale" name="companyName" autoComplete="organization" defaultValue={v.companyName} error={e.companyName} required maxLength={160} />
          <TextField label="Partita IVA" name="vatNumber" defaultValue={v.vatNumber} error={e.vatNumber} required maxLength={16} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Codice destinatario SDI" name="sdiCode" defaultValue={v.sdiCode} error={e.sdiCode} maxLength={7} />
            <TextField label="PEC" name="pec" type="email" defaultValue={v.pec} error={e.pec} />
          </div>
          <p className="text-xs text-zinc-500">Per la fattura elettronica indica almeno il codice SDI oppure la PEC.</p>
        </div>
      ) : null}

      <TextField label="E-mail" name="email" type="email" autoComplete="email" defaultValue={v.email} error={e.email} required />
      <TextField label="Telefono" name="phone" type="tel" autoComplete="tel" defaultValue={v.phone} error={e.phone} hint="Facoltativo." />
      <PasswordFields errors={e} />

      {type === "private" ? (
        <p className="text-xs text-zinc-500">Codice fiscale e indirizzo di fatturazione ti verranno chiesti al momento del primo ordine.</p>
      ) : null}

      <Consents errors={e} values={v} />
      <SubmitButton>Crea account</SubmitButton>
    </form>
  );
}
