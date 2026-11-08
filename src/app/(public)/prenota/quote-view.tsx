"use client";

import { formatCents } from "@/lib/pricing/money";
import type { PublicPorterTerms, PublicQuote } from "@/lib/booking/public-quote";
import type { BookingOptions } from "@/lib/booking/server";
import type { PorterChoice } from "@/lib/booking/state";

type Display = "gross" | "net_plus_vat";

/** "Nel prezzo X h di lavoro; ogni ora successiva iniziata Y € a persona" (D67, D68; D3 for Y). */
export function PorterSentence({ hours, terms, display }: { hours: number; terms: PublicPorterTerms | undefined; display: Display }) {
  const rate =
    terms?.overtimeRateNetCents == null
      ? null
      : display === "gross"
        ? formatCents(terms.overtimeRateGrossCents ?? 0)
        : `${formatCents(terms.overtimeRateNetCents)} + IVA`;
  return (
    <p className="mt-2 rounded-md bg-blue-50 p-3 text-sm text-blue-900">
      Nel prezzo {hours} h di lavoro
      {terms === undefined ? "." : rate ? `; ogni ora successiva iniziata ${rate} a persona.` : "; nessun costo per ore aggiuntive."}
      {terms && rate ? <span className="block text-xs text-blue-800">Tolleranza {terms.overtimeGraceMinutes} minuti. Il tempo conta solo per carico e scarico, non per il viaggio.</span> : null}
    </p>
  );
}

export function PorterPicker({
  id,
  title,
  value,
  onChange,
  options,
  terms,
  display,
}: {
  id: string;
  title: string;
  value: PorterChoice | null;
  onChange: (v: PorterChoice | null) => void;
  options: BookingOptions["porterPackages"];
  terms: PublicPorterTerms | undefined;
  display: Display;
}) {
  const pkg = options.find((p) => p.code === value?.packageCode);
  return (
    <fieldset className="rounded-md border border-zinc-200 p-4">
      <legend className="px-1 text-sm font-medium text-zinc-800">{title}</legend>
      <label htmlFor={`${id}-pkg`} className="block text-sm text-zinc-700">Quantità di merce</label>
      <select
        id={`${id}-pkg`}
        value={value?.packageCode ?? ""}
        onChange={(e) => {
          const code = e.target.value as PorterChoice["packageCode"] | "";
          onChange(code ? { packageCode: code } : null);
        }}
        className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2"
      >
        <option value="">Senza facchini</option>
        {options.map((p) => (
          <option key={p.code} value={p.code}>
            {p.labelIt} — {p.persons} {p.persons === 1 ? "facchino" : "facchini"}, {p.includedHours} h
          </option>
        ))}
      </select>
      {pkg ? (
        <>
          <label htmlFor={`${id}-count`} className="mt-3 block text-sm text-zinc-700">Numero di facchini</label>
          <select
            id={`${id}-count`}
            value={value?.count ?? pkg.persons}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({ packageCode: pkg.code, count: n === pkg.persons ? undefined : n });
            }}
            className="mt-1 block w-32 rounded-md border border-zinc-300 px-3 py-2"
          >
            {Array.from({ length: 4 - pkg.persons + 1 }, (_, i) => pkg.persons + i).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-zinc-500">Ogni facchino in più lavora le stesse {pkg.includedHours} h incluse.</p>
          <PorterSentence hours={pkg.includedHours} terms={terms} display={display} />
        </>
      ) : null}
    </fieldset>
  );
}

/** Full price breakdown (D3: private gross per line, business net + VAT). */
export function QuoteBreakdown({ quote }: { quote: PublicQuote }) {
  const gross = quote.display === "gross";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <tbody>
          {quote.lines.map((l, i) => (
            <tr key={i} className="border-b border-zinc-100">
              <td className="py-2 pr-4 text-zinc-700">{l.labelIt}</td>
              <td className="py-2 text-right whitespace-nowrap text-zinc-900">{formatCents(gross ? l.grossCents : l.netCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {gross ? (
            <tr>
              <td className="pt-3 font-semibold">Totale (IVA inclusa)</td>
              <td className="pt-3 text-right font-semibold whitespace-nowrap">{formatCents(quote.totalCents)}</td>
            </tr>
          ) : (
            <>
              <tr>
                <td className="pt-3">Imponibile</td>
                <td className="pt-3 text-right whitespace-nowrap">{formatCents(quote.subtotalCents)}</td>
              </tr>
              <tr>
                <td>IVA {quote.vatRateBp / 100}%</td>
                <td className="text-right whitespace-nowrap">{formatCents(quote.vatCents)}</td>
              </tr>
              <tr>
                <td className="font-semibold">Totale</td>
                <td className="text-right font-semibold whitespace-nowrap">{formatCents(quote.totalCents)}</td>
              </tr>
            </>
          )}
        </tfoot>
      </table>
      {gross ? <p className="mt-1 text-xs text-zinc-500">di cui IVA {formatCents(quote.vatCents)}</p> : null}
    </div>
  );
}

/** Headline amount: private → gross "IVA inclusa"; business → net "+ IVA" (D3). */
export function Headline({ cents, display }: { cents: number; display: Display }) {
  return (
    <span>
      <span className="text-2xl font-semibold text-zinc-900">{formatCents(cents)}</span>{" "}
      <span className="text-sm text-zinc-500">{display === "gross" ? "IVA inclusa" : "+ IVA"}</span>
    </span>
  );
}
