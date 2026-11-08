"use client";

import { startTransition, useActionState, useState, type FormEvent, type ReactNode } from "react";
import { formatCents } from "@/lib/pricing/money";
import { PORTER_PACKAGE_LABEL } from "@/lib/pricing/rule-meta";
import { PORTER_PACKAGE_CODES } from "@/lib/pricing/types";
import { previewQuoteAction, type PreviewState } from "./preview-action";

const input = "w-full rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-900 disabled:bg-zinc-100 disabled:text-zinc-400";

function Section({ title, className = "", children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <fieldset className={`min-w-0 rounded-md border border-zinc-200 p-3 ${className}`}>
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</legend>
      {children}
    </fieldset>
  );
}

/** Field rows share one subgrid (label / control / hint), so controls in a row stay on the same line
 *  even when a label wraps. One column on phones. */
function Fields({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`grid grid-cols-1 gap-x-3 gap-y-1 ${className}`}>{children}</div>;
}

/** `htmlFor` = id of the control; a div (not a wrapping label) so the "after" checkbox keeps its own label. */
function Field({ label, htmlFor, hint, after, children }: { label: string; htmlFor: string; hint?: string; after?: ReactNode; children: ReactNode }) {
  return (
    <div className="row-span-3 grid grid-rows-subgrid">
      <label htmlFor={htmlFor} className="self-end font-medium text-zinc-700">{label}</label>
      {children}
      <div className="pb-2 text-xs text-zinc-500">{after ?? hint}</div>
    </div>
  );
}

function Checkbox({ name, label }: { name: string; label: string }) {
  return (
    <label className="mt-1 flex items-center gap-2 text-sm text-zinc-700">
      <input type="checkbox" name={name} /> {label}
    </label>
  );
}

export function QuotePreview({ priceListId, vehicles, defaultPickup }: { priceListId: string; vehicles: { id: string; name: string }[]; defaultPickup: string }) {
  const [state, action, pending] = useActionState<PreviewState, FormData>(previewQuoteAction, {});
  // Fields stay as typed: we submit via onSubmit + startTransition instead of <form action>, because
  // React resets uncontrolled fields after a form action. Any edit after a calculation marks the result
  // as stale until the next "Calcola preventivo".
  const [stale, setStale] = useState(false);
  // Only to enable/disable dependent fields (disabled fields are not submitted, same result as empty).
  const [porterPackage, setPorterPackage] = useState("");
  const [storageDays, setStorageDays] = useState("");
  const outdated = stale || pending;
  const q = state.quote;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setStale(false);
    startTransition(() => action(fd));
  }

  return (
    <div>
      <form onSubmit={onSubmit} onChange={() => setStale(true)} className="flex flex-col gap-4 text-sm">
        <input type="hidden" name="id" value={priceListId} />

        <Section title="Percorso">
          <Fields className="sm:grid-cols-2 lg:grid-cols-4">
            <Field htmlFor="qp-distance_km" label="Distanza (km)" hint="es. 143,122">
              <input id="qp-distance_km" name="distance_km" defaultValue="143,122" inputMode="decimal" className={input} />
            </Field>
            <Field htmlFor="qp-vehicle_type_id" label="Veicolo">
              <select id="qp-vehicle_type_id" name="vehicle_type_id" className={input}>
                {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>
            <Field htmlFor="qp-pickup_at" label="Ritiro" hint="ora italiana">
              <input type="datetime-local" id="qp-pickup_at" name="pickup_at" defaultValue={defaultPickup} className={input} />
            </Field>
            <Field htmlFor="qp-customer_type" label="Cliente">
              <select id="qp-customer_type" name="customer_type" className={input}><option value="private">Privato</option><option value="business">Azienda</option></select>
            </Field>
          </Fields>
        </Section>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-6">
          <Section title="Ritiro" className="lg:col-span-1">
            <Fields>
              <Field htmlFor="qp-pickup_floor" label="Piano" after={<Checkbox name="pickup_elevator" label="Ascensore" />}>
                <input id="qp-pickup_floor" name="pickup_floor" defaultValue="0" inputMode="numeric" className={input} />
              </Field>
            </Fields>
          </Section>

          <Section title="Consegna" className="lg:col-span-1">
            <Fields>
              <Field htmlFor="qp-delivery_floor" label="Piano" after={<Checkbox name="delivery_elevator" label="Ascensore" />}>
                <input id="qp-delivery_floor" name="delivery_floor" defaultValue="0" inputMode="numeric" className={input} />
              </Field>
            </Fields>
          </Section>

          <Section title="Servizi" className="lg:col-span-2">
            <Fields className="sm:grid-cols-2">
              <Field htmlFor="qp-porter_package" label="Facchinaggio">
                <select id="qp-porter_package" name="porter_package" defaultValue="" onChange={(e) => setPorterPackage(e.target.value)} className={input}>
                  <option value="">Nessuno</option>
                  {PORTER_PACKAGE_CODES.map((c) => <option key={c} value={c}>{PORTER_PACKAGE_LABEL[c]}</option>)}
                </select>
              </Field>
              <Field htmlFor="qp-porters_count" label="Facchini (persone)" hint="vuoto = numero della categoria">
                <input id="qp-porters_count" name="porters_count" defaultValue="" inputMode="numeric" disabled={!porterPackage} className={input} />
              </Field>
              <Field htmlFor="qp-packing_items" label="Imballaggio (colli)" hint="0 = nessun imballaggio">
                <input id="qp-packing_items" name="packing_items" defaultValue="0" inputMode="numeric" className={input} />
              </Field>
            </Fields>
          </Section>

          <Section title="Deposito" className="lg:col-span-2">
            <Fields className="sm:grid-cols-2">
              <Field htmlFor="qp-storage_days" label="Giorni" hint="vuoto = nessun deposito">
                <input id="qp-storage_days" name="storage_days" defaultValue="" inputMode="numeric" onChange={(e) => setStorageDays(e.target.value.trim())} className={input} />
              </Field>
              <Field htmlFor="qp-storage_pallets" label="Pallet" hint="solo con tariffa per pallet">
                <input id="qp-storage_pallets" name="storage_pallets" defaultValue="" inputMode="numeric" disabled={!storageDays} className={input} />
              </Field>
            </Fields>
          </Section>
        </div>

        <div className="border-t border-zinc-200 pt-3">
          <button type="submit" disabled={pending} className="w-full rounded-md bg-zinc-800 px-3 py-1.5 font-medium text-white disabled:opacity-60 sm:w-auto">
            {pending ? "Calcolo…" : "Calcola preventivo"}
          </button>
        </div>
      </form>

      {(state.error || q) && stale ? (
        <p role="status" className="mt-3 text-sm font-medium text-amber-700">Dati modificati: risultato non aggiornato. Premi «Calcola preventivo».</p>
      ) : null}
      {state.error ? <p role="alert" className={`mt-3 text-sm text-red-700 ${outdated ? "opacity-40" : ""}`}>{state.error}</p> : null}
      {q ? (
        <div aria-hidden={outdated || undefined} className={`mt-4 overflow-x-auto transition-opacity ${outdated ? "opacity-40" : ""}`}>
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr><th className="py-1">Voce</th><th>Q.tà</th><th className="text-right">Netto</th><th className="text-right">IVA</th><th className="text-right">Lordo</th><th className="text-right">Padroncino</th></tr>
            </thead>
            <tbody>
              {q.lines.map((l, i) => (
                <tr key={i} className="border-t border-zinc-100">
                  <td className="py-1">{l.labelIt}</td><td>{l.quantity}</td>
                  <td className="text-right">{formatCents(l.netCents)}</td><td className="text-right">{formatCents(l.vatCents)}</td>
                  <td className="text-right">{formatCents(l.grossCents)}</td><td className="text-right">{formatCents(l.carrierAmountCents)}</td>
                </tr>
              ))}
              <tr className="border-t border-zinc-300 font-semibold">
                <td className="py-1">Totale</td><td />
                <td className="text-right">{formatCents(q.subtotalCents)}</td><td className="text-right">{formatCents(q.vatCents)}</td>
                <td className="text-right">{formatCents(q.totalCents)}</td><td className="text-right">{formatCents(q.carrierAmountCents)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-sm">
            Margine Transigo (netto): <strong>{formatCents(q.subtotalCents - q.carrierAmountCents)}</strong>
            {q.isUrgentByLeg[0] ? " · urgente" : ""}
          </p>
          {q.porters.map((p) => (
            <p key={p.legIndex} className="mt-1 text-sm">
              Facchinaggio: incluse {p.includedHours} h di lavoro
              {p.overtimeRatePerPersonCents !== null
                ? `, ogni ora successiva iniziata ${formatCents(p.overtimeRatePerPersonCents)} a persona (tolleranza ${p.overtimeGraceMinutes} min).`
                : "; ore extra non addebitate (regola disattivata)."}
            </p>
          ))}
          {q.warnings.length ? <p className="mt-1 text-sm text-red-700">Attenzione: la quota padroncino supera l&apos;importo del servizio ({q.warnings.map((w) => w.group).join(", ")}).</p> : null}
        </div>
      ) : null}
    </div>
  );
}
