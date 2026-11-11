import type { PorterSummary } from "@/lib/carriers/execution";

/** Porter working time per leg (D69) — minutes from the database; overtime in hours, never amounts. */
export function PorterTime({ porters, multiLeg, title = "Tempo di lavoro dei facchini" }: { porters: readonly PorterSummary[]; multiLeg: boolean; title?: string }) {
  if (!porters.length) return null;
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4">
      <h2 className="font-semibold text-zinc-900">{title}</h2>
      <p className="mt-1 text-xs text-zinc-500">Solo carico e scarico, senza il viaggio. Arrotondato per difetto al minuto.</p>
      <ul className="mt-3 space-y-2 text-sm">
        {porters.map((p) => (
          <li key={p.legIndex} className="rounded-lg bg-zinc-50 p-2">
            {multiLeg ? <span className="block text-zinc-500">Tratta {p.legIndex + 1}</span> : null}
            <span className="block text-base font-semibold text-zinc-900">{p.workedLabel}</span>
            <span className="block text-zinc-600">Incluse nel prezzo: {p.includedLabel}</span>
            {p.overtimeHours > 0 ? (
              <span className="mt-1 block font-medium text-amber-800">
                Ore extra per facchino: {p.overtimeHours} {p.overtimeHours === 1 ? "ora" : "ore"} (da saldare a parte)
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
