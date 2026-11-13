import type { PublicVehicle } from "@/lib/public/server";
import { VehicleIllustration } from "./vehicle-illustration";

// Small building blocks shared by the public pages (home, services, …).

export function SectionTitle({ eyebrow, title, center = false }: { eyebrow: string; title: string; center?: boolean }) {
  return (
    <div className={center ? "text-center" : ""}>
      <p className="text-sm font-semibold uppercase tracking-wide text-accent-600">{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-bold tracking-tight text-brand-900">{title}</h2>
    </div>
  );
}

export function Check({ className = "text-accent-400" }: { className?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d="M4 10.5l4 4 8-9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckList({ items, onDark = false }: { items: string[]; onDark?: boolean }) {
  return (
    <ul className="space-y-3">
      {items.map((t) => (
        <li key={t} className={`flex items-start gap-3 ${onDark ? "text-brand-100" : "text-zinc-700"}`}>
          <span className="mt-0.5">
            <Check className={onDark ? "text-accent-400" : "text-accent-600"} />
          </span>
          {t}
        </li>
      ))}
    </ul>
  );
}

/** Path of the price calculator of the home page (hero card with the service tabs). */
export const CALCULATOR_HREF = "/#calcola";

/**
 * "Calcola il prezzo" → the calculator of the home page (owner feedback 2026-11-13), not the transport wizard.
 * Native anchor: scrolls to it on every click, also when already on the home page.
 */
export function PrimaryCta({ href = CALCULATOR_HREF, children = "Calcola il prezzo" }: { href?: string; children?: React.ReactNode }) {
  return (
    <a href={href} className="inline-block rounded-md bg-accent-500 px-6 py-3 font-semibold text-white hover:bg-accent-600">
      {children}
    </a>
  );
}

export const numberIt = new Intl.NumberFormat("it-IT");

export function VehicleCard({ v }: { v: PublicVehicle }) {
  // Narrow no-break spaces (U+202F) around "×": one line also in the 4-column grid (D183).
  const dims = v.lengthCm && v.widthCm && v.heightCm ? `${numberIt.format(v.lengthCm)}\u202f×\u202f${numberIt.format(v.widthCm)}\u202f×\u202f${numberIt.format(v.heightCm)}\u00a0cm` : null;
  const rows: [string, string | null][] = [
    ["Portata", v.payloadKg ? `${numberIt.format(v.payloadKg)} kg` : null],
    ["Vano di carico", dims],
    ["Volume", v.volumeM3 ? `${numberIt.format(v.volumeM3)} m³` : null],
    ["Pallet EUR", v.euroPallets ? String(v.euroPallets) : null],
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="bg-brand-50 px-6 pb-2 pt-5">
        <VehicleIllustration sizeRank={v.sizeRank} className="mx-auto h-28 w-full max-w-64" />
      </div>
      <div className="px-4 py-5">
        <h3 className="text-lg font-semibold text-brand-900">{v.name}</h3>
        <dl className="mt-3 space-y-1 text-sm">
          {rows.filter(([, value]) => value).map(([k, value]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="whitespace-nowrap text-zinc-500">{k}</dt>
              <dd className="whitespace-nowrap font-medium text-zinc-800">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export function VehicleGrid({ vehicles }: { vehicles: PublicVehicle[] }) {
  return (
    // D183: four vehicle types → one row of four on desktop; other counts keep rows of three.
    <div className={`grid gap-5 sm:grid-cols-2 ${vehicles.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
      {vehicles.map((v) => (
        <VehicleCard key={v.id} v={v} />
      ))}
    </div>
  );
}
