"use client";

import Link from "next/link";
import { useState } from "react";
import { formatCents } from "@/lib/pricing/money";
import { portersEstimate, STORAGE_MAX_DAYS, PALLETS_MAX, storageEstimate, type Estimate, type PublicRates } from "@/lib/public/rates";
import { portersRequestHref, storageRequestHref } from "@/lib/public/requests";

// Home-page mini calculators (D162): indicative price from the public rates of the active price list, computed
// in the browser with the engine's own functions. No carrier amounts exist in this data. The button opens the
// contact form pre-filled with the chosen values until the Facchini / Deposito wizards exist (plan steps 6–7).

const field = "mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-brand-500";
const label = "block text-sm font-medium text-zinc-800";

type StorageUnit = "box" | "pallet";

/** Box (privati) or pallet (aziende) — D154. The price is always shown net + IVA on public pages (D181). */
function UnitToggle({ value, onChange, units }: { value: StorageUnit; onChange: (v: StorageUnit) => void; units: StorageUnit[] }) {
  const labels: Record<StorageUnit, string> = { box: "Box", pallet: "Pallet" };
  return (
    <fieldset>
      <legend className="sr-only">Cosa vuoi depositare</legend>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1 text-sm">
        {units.map((v) => (
          <label key={v} htmlFor={`storage-unit-${v}`} className={`cursor-pointer rounded-md px-3 py-1.5 text-center font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500 ${value === v ? "bg-white text-brand-900 shadow-sm" : "text-zinc-600"}`}>
            <input id={`storage-unit-${v}`} type="radio" name="storage-unit" value={v} checked={value === v} onChange={() => onChange(v)} className="sr-only" />
            {labels[v]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Whole-number input kept within [min, max]; an empty field is allowed while typing. */
function NumberField({ id, text, value, onChange, min, max, suffix }: { id: string; text: string; value: number | ""; onChange: (v: number | "") => void; min: number; max: number; suffix?: string }) {
  return (
    <div>
      <label htmlFor={id} className={label}>{text}</label>
      <div className="relative">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return onChange("");
            const n = Math.trunc(Number(raw));
            if (Number.isFinite(n)) onChange(Math.min(max, Math.max(0, n)));
          }}
          onBlur={() => onChange(value === "" || value < min ? min : value)}
          className={`${field} ${suffix ? "pr-14" : ""}`}
        />
        {suffix ? <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-zinc-500">{suffix}</span> : null}
      </div>
    </div>
  );
}

/** One price for everyone on public pages: net + IVA (D181); the wizard shows the price of the account type (D3). */
function PriceBox({ estimate, note, excluded }: { estimate: Estimate | null; note?: string | null; excluded: string }) {
  return (
    <div className="rounded-lg bg-brand-50 p-4" aria-live="polite">
      <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Prezzo indicativo</p>
      {estimate ? (
        <p className="mt-1 text-2xl font-bold text-brand-900">
          {formatCents(estimate.netCents)} <span className="text-sm font-medium text-zinc-600">+ IVA</span>
        </p>
      ) : (
        <p className="mt-1 text-sm text-zinc-600">Completa i campi per vedere il prezzo.</p>
      )}
      {note ? <p className="mt-1 text-sm text-zinc-700">{note}</p> : null}
      <p className="mt-2 text-xs text-zinc-500">{excluded} Il prezzo definitivo è confermato nella prenotazione.</p>
    </div>
  );
}

function RequestButton({ href, enabled, online = false }: { href: string; enabled: boolean; online?: boolean }) {
  const text = online ? "Prenota online" : "Richiedi la prenotazione";
  return (
    <div>
      {enabled ? (
        // Full page load: the wizard always starts from these values, also on a second click after going back
        // (a client navigation can reuse the wizard kept alive by the router, with the old values).
        <a href={href} className="block w-full rounded-md bg-accent-600 px-4 py-3 text-center text-base font-semibold text-white hover:bg-accent-700">
          {text}
        </a>
      ) : (
        <span aria-disabled="true" className="block w-full cursor-not-allowed rounded-md bg-accent-600/50 px-4 py-3 text-center text-base font-semibold text-white">
          {text}
        </span>
      )}
      {online ? null : <p className="mt-2 text-center text-xs text-zinc-500">Prenotazione online in arrivo: per ora ti ricontattiamo noi.</p>}
    </div>
  );
}

export function PortersCalculator({ rates }: { rates: PublicRates }) {
  const p = rates.porters!;
  const [persons, setPersons] = useState(p.minPersons);
  const [hours, setHours] = useState<number | "">(p.minHours);
  const [floor, setFloor] = useState<number | "">(0);
  const [hasElevator, setHasElevator] = useState(false);

  const input = hours === "" || floor === "" ? null : { persons, hours, floor, hasElevator };
  const estimate = input ? portersEstimate(rates, input, "business") : null;
  const personsOptions = Array.from({ length: p.maxPersons - p.minPersons + 1 }, (_, i) => p.minPersons + i);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="porters-persons" className={label}>Facchini</label>
          <select id="porters-persons" value={persons} onChange={(e) => setPersons(Number(e.target.value))} className={field}>
            {personsOptions.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <NumberField id="porters-hours" text="Ore stimate" value={hours} onChange={setHours} min={1} max={p.maxHours} suffix="ore" />
        <NumberField id="porters-floor" text="Piano" value={floor} onChange={setFloor} min={0} max={p.maxFloor} />
        <label className="mt-6 flex items-center gap-2 text-sm text-zinc-800">
          <input type="checkbox" checked={hasElevator} onChange={(e) => setHasElevator(e.target.checked)} className="h-4 w-4" />
          C&apos;è l&apos;ascensore
        </label>
      </div>
      <PriceBox
        estimate={estimate}
        note={input && input.hours < p.minHours ? `Minimo ${p.minHours} ore per facchino.` : null}
        excluded="Supplementi per urgenza, weekend e festivi esclusi."
      />
      <RequestButton href={input ? portersRequestHref(input) : "#"} enabled={!!estimate && !!input} online />
    </div>
  );
}

const DURATIONS = [
  { days: 7, label: "1 settimana" },
  { days: 30, label: "1 mese" },
  { days: 90, label: "3 mesi" },
  { days: 180, label: "6 mesi" },
];

export function StorageCalculator({ rates }: { rates: PublicRates }) {
  const s = rates.storage!;
  const hasBoxes = s.boxes.length > 0;
  const hasPallets = !!s.pallets;
  const units: StorageUnit[] = [...(hasBoxes ? ["box" as const] : []), ...(hasPallets ? ["pallet" as const] : [])];
  const [chosen, setChosen] = useState<StorageUnit>(hasBoxes ? "box" : "pallet");
  const [boxCode, setBoxCode] = useState(s.boxes[0]?.code ?? "");
  const [pallets, setPallets] = useState<number | "">(1);
  const [days, setDays] = useState<number | "">(30);

  // D154: boxes for private customers, pallets for businesses.
  const unit = units.includes(chosen) ? chosen : null;
  const input =
    days === "" || !unit
      ? null
      : unit === "box"
        ? ({ unit: "box", boxCode, days } as const)
        : pallets === ""
          ? null
          : ({ unit: "pallet", pallets, days } as const);
  const estimate = input ? storageEstimate(rates, input, input?.unit === "box" ? "private" : "business") : null;

  return (
    <div className="space-y-4">
      {units.length > 1 ? <UnitToggle value={chosen} onChange={setChosen} units={units} /> : null}
      {unit === null ? (
        <p className="rounded-lg bg-zinc-50 p-4 text-sm text-zinc-700">
          Al momento il deposito non è prenotabile online.{" "}
          <Link href="/contatti" className="font-semibold text-brand-700 underline">Scrivici</Link>.
        </p>
      ) : (
        <>
          {unit === "box" ? (
            <div>
              <label htmlFor="storage-box" className={label}>Box</label>
              <select id="storage-box" value={boxCode} onChange={(e) => setBoxCode(e.target.value)} className={field}>
                {s.boxes.map((b) => (
                  <option key={b.code} value={b.code}>{b.label} – {String(b.volumeM3).replace(".", ",")} m³</option>
                ))}
              </select>
            </div>
          ) : (
            <NumberField id="storage-pallets" text="Pallet" value={pallets} onChange={setPallets} min={1} max={PALLETS_MAX} />
          )}
          <div>
            <NumberField id="storage-days" text="Durata" value={days} onChange={setDays} min={1} max={STORAGE_MAX_DAYS} suffix="giorni" />
            <div className="mt-2 flex flex-wrap gap-2">
              {DURATIONS.map((d) => (
                <button
                  key={d.days}
                  type="button"
                  onClick={() => setDays(d.days)}
                  aria-pressed={days === d.days}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${days === d.days ? "border-brand-700 bg-brand-700 text-white" : "border-zinc-300 text-zinc-700 hover:bg-zinc-50"}`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <PriceBox estimate={estimate} excluded="Trasporto da e per il magazzino escluso." />
          <RequestButton href={input ? storageRequestHref(input) : "#"} enabled={!!estimate && !!input} online />
        </>
      )}
    </div>
  );
}
