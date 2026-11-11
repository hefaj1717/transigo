"use client";

import Link from "next/link";

// Billing data and terms of the "Riepilogo" step (D36, D42, D43, D44), shared by the booking wizards.
// Kept in memory only (D78); validated again on the server (privateBillingSchema / businessBillingSchema).

export const BILLING_FIELDS = ["fiscalCode", "companyName", "vatNumber", "sdiCode", "pec", "street", "city", "postalCode", "province"] as const;
export type Billing = Record<(typeof BILLING_FIELDS)[number], string>;
export const EMPTY_BILLING = Object.fromEntries(BILLING_FIELDS.map((f) => [f, ""])) as Billing;

const input = "mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-blue-500";
const label = "block text-sm font-medium text-zinc-800";

type Props = { business: boolean; billing: Billing; setBilling: (b: Billing) => void; errors: Record<string, string> };

export function BillingFields({ business, billing, setBilling, errors }: Props) {
  const field = (name: keyof Billing, text: string, required = false) => (
    <BillingInput name={name} label={text} billing={billing} setBilling={setBilling} error={errors[`billing.${name}`]} required={required} />
  );
  return (
    <fieldset className="space-y-4">
      <legend className="text-sm font-medium text-zinc-800">Dati di fatturazione</legend>
      {business ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {field("companyName", "Ragione sociale", true)}
          {field("vatNumber", "Partita IVA", true)}
          {field("sdiCode", "Codice destinatario SDI")}
          {field("pec", "PEC")}
        </div>
      ) : (
        field("fiscalCode", "Codice fiscale", true)
      )}
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem_6rem]">
        {field("street", "Indirizzo di fatturazione", true)}
        {field("postalCode", "CAP", true)}
        {field("province", "Provincia", true)}
      </div>
      {field("city", "Città", true)}
      <p className="text-xs text-zinc-500">I dati valgono per questo ordine; il tuo profilo non viene modificato.</p>
    </fieldset>
  );
}

export function TermsCheckbox({ checked, onChange, error }: { checked: boolean; onChange: (v: boolean) => void; error?: string }) {
  return (
    <div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>Accetto i <Link href="/termini" target="_blank" className="text-blue-700 underline">Termini e condizioni</Link> del servizio *</span>
      </label>
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

function BillingInput({ name, label: text, billing, setBilling, error, required }: {
  name: keyof Billing; label: string; billing: Billing; setBilling: (b: Billing) => void; error?: string; required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={`billing-${name}`} className={label}>
        {text}
        {required ? <span className="text-red-600"> *</span> : null}
      </label>
      <input id={`billing-${name}`} value={billing[name]} onChange={(e) => setBilling({ ...billing, [name]: e.target.value })} aria-invalid={error ? true : undefined} className={`${input} ${error ? "border-red-500" : ""}`} />
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
