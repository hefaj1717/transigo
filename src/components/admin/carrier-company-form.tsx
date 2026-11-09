"use client";

import { useActionState } from "react";
import { updateCompanyAction } from "@/app/(admin)/admin/padroncini/actions";
import { FormMessage, TextField } from "@/components/form-field";
import { initialCarrierFormState } from "@/lib/carriers/form-state";

export type AdminCompanyValues = {
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

// "Modifica dati aziendali" by the admin (D105): admin_update_carrier_company() with an audit entry listing the
// changed fields. Same validation as the carrier's form.
export function AdminCarrierCompanyForm({ carrierId, initial }: { carrierId: string; initial: AdminCompanyValues }) {
  const [state, action, pending] = useActionState(updateCompanyAction, initialCarrierFormState);
  const e = state.errors ?? {};
  const v = { ...initial, ...state.values };
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="carrierId" value={carrierId} />
      <FormMessage error={e._form} success={state.message} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Ragione sociale" name="companyName" defaultValue={v.companyName} error={e.companyName} required maxLength={160} className="sm:col-span-2" />
        <TextField label="Partita IVA" name="vatNumber" defaultValue={v.vatNumber} error={e.vatNumber} required maxLength={16} />
        <TextField label="Codice fiscale" name="fiscalCode" defaultValue={v.fiscalCode} error={e.fiscalCode} required maxLength={16} />
        <TextField label="Indirizzo sede" name="hqStreet" defaultValue={v.hqStreet} error={e.hqStreet} required maxLength={160} className="sm:col-span-2" />
        <TextField label="Città" name="hqCity" defaultValue={v.hqCity} error={e.hqCity} required maxLength={80} />
        <div className="grid grid-cols-2 gap-4">
          <TextField label="CAP" name="hqPostalCode" defaultValue={v.hqPostalCode} error={e.hqPostalCode} required maxLength={5} />
          <TextField label="Provincia" name="hqProvince" defaultValue={v.hqProvince} error={e.hqProvince} required maxLength={2} />
        </div>
        <TextField label="Codice destinatario SDI" name="sdiCode" defaultValue={v.sdiCode} error={e.sdiCode} maxLength={7} />
        <TextField label="PEC" name="pec" type="email" defaultValue={v.pec} error={e.pec} />
      </div>
      <p className="text-xs text-zinc-500">Almeno il codice SDI oppure la PEC. Ogni modifica viene registrata nel log (solo i nomi dei campi).</p>
      <button type="submit" disabled={pending} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
        {pending ? "Salvataggio…" : "Salva dati aziendali"}
      </button>
    </form>
  );
}
