"use client";

import { useActionState } from "react";
import { saveCompanyAction } from "@/app/(padroncino)/padroncino/actions";
import { FormMessage, TextField } from "@/components/form-field";
import { initialCarrierFormState } from "@/lib/carriers/form-state";
import { bigButton } from "./carrier-shell";

export type CompanyValues = {
  companyName: string;
  vatNumber: string;
  fiscalCode: string;
  hqStreet: string;
  hqCity: string;
  hqPostalCode: string;
  hqProvince: string;
  sdiCode: string;
  pec: string;
};

// "Dati aziendali" during onboarding (D45, D105). Same validation as the registration form.
export function CompanyForm({ initial }: { initial: CompanyValues }) {
  const [state, action, pending] = useActionState(saveCompanyAction, initialCarrierFormState);
  const e = state.errors ?? {};
  const v = { ...initial, ...state.values };

  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage error={e._form} success={state.message} />
      <TextField label="Ragione sociale" name="companyName" autoComplete="organization" defaultValue={v.companyName} error={e.companyName} required maxLength={160} />
      <TextField label="Partita IVA" name="vatNumber" inputMode="numeric" defaultValue={v.vatNumber} error={e.vatNumber} required maxLength={16} />
      <TextField label="Codice fiscale" name="fiscalCode" defaultValue={v.fiscalCode} error={e.fiscalCode} required maxLength={16} />

      <fieldset className="space-y-4">
        <legend className="mb-2 text-base font-semibold text-zinc-900">Sede</legend>
        <TextField label="Indirizzo" name="hqStreet" autoComplete="street-address" defaultValue={v.hqStreet} error={e.hqStreet} required maxLength={160} />
        <TextField label="Città" name="hqCity" autoComplete="address-level2" defaultValue={v.hqCity} error={e.hqCity} required maxLength={80} />
        <div className="grid grid-cols-2 gap-4">
          <TextField label="CAP" name="hqPostalCode" inputMode="numeric" autoComplete="postal-code" defaultValue={v.hqPostalCode} error={e.hqPostalCode} required maxLength={5} />
          <TextField label="Provincia" name="hqProvince" defaultValue={v.hqProvince} error={e.hqProvince} required maxLength={2} placeholder="es. MI" />
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-base font-semibold text-zinc-900">Fatturazione elettronica</legend>
        <TextField label="Codice destinatario SDI" name="sdiCode" defaultValue={v.sdiCode} error={e.sdiCode} maxLength={7} />
        <TextField label="PEC" name="pec" type="email" inputMode="email" defaultValue={v.pec} error={e.pec} />
        <p className="text-xs text-zinc-500">Indica almeno il codice SDI oppure la PEC.</p>
      </fieldset>

      <p className="text-xs text-zinc-500">
        Dopo l&apos;invio per la verifica questi dati non si potranno più modificare: per correggerli dovrai contattare l&apos;assistenza Transigo.
      </p>
      <button type="submit" disabled={pending} className={bigButton}>{pending ? "Salvataggio…" : "Salva dati aziendali"}</button>
    </form>
  );
}
