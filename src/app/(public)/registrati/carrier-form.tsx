"use client";

import { useActionState } from "react";
import { registerCarrier } from "@/lib/auth/actions";
import { initialFormState } from "@/lib/auth/form-state";
import { FormMessage, TextField } from "@/components/form-field";
import { SubmitButton } from "@/components/submit-button";
import { Consents, PasswordFields } from "./consents";

// D45: personal data + company data. Documents, vehicles and Stripe Connect come in Stage 4.
export function CarrierForm() {
  const [state, action] = useActionState(registerCarrier, initialFormState);
  const e = state.errors ?? {};
  const v = state.values ?? {};

  return (
    <form action={action} className="space-y-6" noValidate>
      <FormMessage error={e._form} />

      <Section title="Dati personali">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Nome" name="firstName" autoComplete="given-name" defaultValue={v.firstName} error={e.firstName} required maxLength={80} />
          <TextField label="Cognome" name="lastName" autoComplete="family-name" defaultValue={v.lastName} error={e.lastName} required maxLength={80} />
        </div>
        <TextField label="Cellulare" name="phone" type="tel" autoComplete="tel" defaultValue={v.phone} error={e.phone} required hint="Lo verificheremo con un SMS." />
      </Section>

      <Section title="Dati aziendali">
        <TextField label="Ragione sociale" name="companyName" autoComplete="organization" defaultValue={v.companyName} error={e.companyName} required maxLength={160} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Partita IVA" name="vatNumber" defaultValue={v.vatNumber} error={e.vatNumber} required maxLength={16} />
          <TextField label="Codice fiscale" name="fiscalCode" defaultValue={v.fiscalCode} error={e.fiscalCode} required maxLength={16} />
        </div>
      </Section>

      <Section title="Sede">
        <TextField label="Indirizzo" name="hqStreet" autoComplete="street-address" defaultValue={v.hqStreet} error={e.hqStreet} required maxLength={160} />
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label="Città" name="hqCity" autoComplete="address-level2" defaultValue={v.hqCity} error={e.hqCity} required maxLength={80} />
          <TextField label="CAP" name="hqPostalCode" autoComplete="postal-code" defaultValue={v.hqPostalCode} error={e.hqPostalCode} required maxLength={5} />
          <TextField label="Provincia" name="hqProvince" defaultValue={v.hqProvince} error={e.hqProvince} required maxLength={2} hint="Sigla, es. MI" />
        </div>
      </Section>

      <Section title="Fatturazione elettronica">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Codice destinatario SDI" name="sdiCode" defaultValue={v.sdiCode} error={e.sdiCode} maxLength={7} />
          <TextField label="PEC" name="pec" type="email" defaultValue={v.pec} error={e.pec} />
        </div>
        <p className="text-xs text-zinc-500">Indica almeno il codice SDI oppure la PEC.</p>
      </Section>

      <Section title="Accesso">
        <TextField label="E-mail" name="email" type="email" autoComplete="email" defaultValue={v.email} error={e.email} required />
        <PasswordFields errors={e} />
      </Section>

      <p className="text-xs text-zinc-500">
        Documenti, veicolo e dati per i pagamenti li caricherai dopo la conferma dell&apos;e-mail. L&apos;account sarà attivo dopo la verifica da parte di Transigo.
      </p>
      <Consents errors={e} values={v} />
      <SubmitButton>Crea account</SubmitButton>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-4">
      <legend className="mb-2 text-base font-semibold text-zinc-900">{title}</legend>
      {children}
    </fieldset>
  );
}
