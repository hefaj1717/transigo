"use client";

import { startTransition, useActionState, useState, type FormEvent } from "react";
import { formatCents } from "@/lib/pricing/money";
import { PORTER_PACKAGE_LABEL } from "@/lib/pricing/rule-meta";
import { PORTER_PACKAGE_CODES } from "@/lib/pricing/types";
import { previewQuoteAction, type PreviewState } from "./preview-action";

const input = "rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-900";

export function QuotePreview({ priceListId, vehicles, defaultPickup }: { priceListId: string; vehicles: { id: string; name: string }[]; defaultPickup: string }) {
  const [state, action, pending] = useActionState<PreviewState, FormData>(previewQuoteAction, {});
  // Fields stay as typed: we submit via onSubmit + startTransition instead of <form action>, because
  // React resets uncontrolled fields after a form action. Any edit after a calculation marks the result
  // as stale until the next "Calcola preventivo".
  const [stale, setStale] = useState(false);
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
      <form onSubmit={onSubmit} onChange={() => setStale(true)} className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <input type="hidden" name="id" value={priceListId} />
        <label className="flex flex-col gap-1">Distanza (km)<input name="distance_km" defaultValue="143,122" className={input} /></label>
        <label className="flex flex-col gap-1">Veicolo
          <select name="vehicle_type_id" className={input}>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Ritiro (ora italiana)<input type="datetime-local" name="pickup_at" defaultValue={defaultPickup} className={input} /></label>
        <label className="flex flex-col gap-1">Cliente
          <select name="customer_type" className={input}><option value="private">Privato</option><option value="business">Azienda</option></select>
        </label>
        <label className="flex flex-col gap-1">Piano ritiro<input name="pickup_floor" defaultValue="0" className={input} /></label>
        <label className="flex items-center gap-2"><input type="checkbox" name="pickup_elevator" /> Ascensore al ritiro</label>
        <label className="flex flex-col gap-1">Piano consegna<input name="delivery_floor" defaultValue="0" className={input} /></label>
        <label className="flex items-center gap-2"><input type="checkbox" name="delivery_elevator" /> Ascensore alla consegna</label>
        <label className="flex flex-col gap-1">Facchinaggio
          <select name="porter_package" defaultValue="" className={input}>
            <option value="">Nessuno</option>
            {PORTER_PACKAGE_CODES.map((c) => <option key={c} value={c}>{PORTER_PACKAGE_LABEL[c]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Facchini (persone, vuoto = da categoria)<input name="porters_count" defaultValue="" className={input} /></label>
        <label className="flex flex-col gap-1">Imballaggio (colli)<input name="packing_items" defaultValue="0" className={input} /></label>
        <label className="flex flex-col gap-1">Deposito (giorni, vuoto = no)<input name="storage_days" defaultValue="" className={input} /></label>
        <label className="flex flex-col gap-1">Deposito (pallet)<input name="storage_pallets" defaultValue="" className={input} /></label>
        <div className="col-span-2 flex items-end sm:col-span-4">
          <button type="submit" disabled={pending} className="rounded-md bg-zinc-800 px-3 py-1.5 font-medium text-white disabled:opacity-60">
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
          {q.porters ? (
            <p className="mt-1 text-sm">
              Facchinaggio: incluse {q.porters.includedHours} h di lavoro
              {q.porters.overtimeRatePerPersonCents !== null
                ? `, ogni ora successiva iniziata ${formatCents(q.porters.overtimeRatePerPersonCents)} a persona (tolleranza ${q.porters.overtimeGraceMinutes} min).`
                : "; ore extra non addebitate (regola disattivata)."}
            </p>
          ) : null}
          {q.warnings.length ? <p className="mt-1 text-sm text-red-700">Attenzione: la quota padroncino supera l&apos;importo del servizio ({q.warnings.map((w) => w.group).join(", ")}).</p> : null}
        </div>
      ) : null}
    </div>
  );
}
