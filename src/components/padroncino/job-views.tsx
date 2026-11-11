import Link from "next/link";
import type { ReactNode } from "react";
import { formatCents } from "@/lib/pricing/money";
import { formatDuration, formatKm, romeWindow, routeLabel, type JobBlocker, type JobCard, type RouteStop } from "@/lib/carriers/jobs";

// Presentational pieces of the carrier job screens (server components). They render a JobCard — cities,
// provinces, floors, load, services, the carrier's amount — which by construction holds NO street, phone or
// customer name (D119). Personal data is only rendered on "Le mie corse" after accepting.

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function UrgentBadge() {
  return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Urgente</span>;
}

function Stop({ stop }: { stop: RouteStop }) {
  return (
    <span className="break-words">
      {stop.isWarehouse ? "Magazzino " : ""}
      {stop.city} <span className="text-zinc-500">({stop.province})</span>
    </span>
  );
}

/** Vertical route: dots and a line, one stop per row (wraps nicely at 360 px). */
export function RouteList({ stops }: { stops: RouteStop[] }) {
  return (
    <ol className="space-y-1" aria-label="Percorso">
      {stops.map((s, i) => (
        <li key={i} className="flex items-start gap-2">
          <span aria-hidden className={`mt-1.5 size-2.5 shrink-0 rounded-full ${i === 0 ? "bg-[#0B3B8C]" : i === stops.length - 1 ? "bg-green-600" : "bg-zinc-400"}`} />
          <span className="min-w-0 font-medium text-zinc-900">
            <Stop stop={s} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One available job on "Corse disponibili": the whole card is the link to the details. */
export function JobListCard({ job, href }: { job: JobCard; href: string }) {
  return (
    <Link
      href={href}
      aria-label={`Corsa ${job.orderNumber}: ${routeLabel(job.stops)}, ${formatCents(job.amount.totalCents)}`}
      className="block rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm active:bg-zinc-50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <RouteList stops={job.stops} />
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-bold text-zinc-900">{formatCents(job.amount.totalCents)}</p>
          <p className="text-xs text-zinc-500">per te</p>
        </div>
      </div>
      <p className="mt-3 text-sm text-zinc-800 first-letter:uppercase">{romeWindow(job.pickupWindowStart, job.pickupWindowEnd)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-600">
        {job.porters ? (
          <>
            <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-semibold text-violet-900">Facchinaggio</span>
            <span>{job.porters.persons} facchini · {job.porters.hours} h</span>
            {job.porters.floor ? (
              <>
                <span aria-hidden>·</span>
                <span>{job.porters.floor}</span>
              </>
            ) : null}
          </>
        ) : (
          <>
            <span>{formatKm(job.distanceM)}</span>
            <span aria-hidden>·</span>
            <span>{formatDuration(job.durationS)} di guida</span>
            <span aria-hidden>·</span>
            <span>{job.vehicleTypeName}</span>
          </>
        )}
        {job.isUrgent ? <UrgentBadge /> : null}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
        <span>Corsa {job.orderNumber}</span>
        <span className="font-semibold text-[#0B3B8C]">Dettagli →</span>
      </div>
    </Link>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">{title}</h2>
      <div className="mt-2 text-zinc-800">{children}</div>
    </section>
  );
}

/** Route, legs (window, km, floors, porters), load and services — the same on both sides of "Accetta". */
export function JobFacts({ job }: { job: JobCard }) {
  if (job.porters) return <PortersFacts job={job} porters={job.porters} />;
  return (
    <>
      <Section title="Percorso">
        <RouteList stops={job.stops} />
        <p className="mt-3 text-sm text-zinc-600">
          {formatKm(job.distanceM)} · {formatDuration(job.durationS)} di guida (stima)
        </p>
      </Section>

      {job.legs.map((l) => (
        <Section key={l.legIndex} title={job.legs.length > 1 ? `Tratta ${l.legIndex + 1}` : "Ritiro e consegna"}>
          <dl className="space-y-2 text-sm">
            <Fact label="Ritiro">
              {capitalize(romeWindow(l.pickupWindowStart, l.pickupWindowEnd))}
              {l.isUrgent ? <span className="ml-2 inline-block"><UrgentBadge /></span> : null}
            </Fact>
            <Fact label="Da">
              <Stop stop={l.from} />
              {l.pickupFloor ? <span className="block text-zinc-600">{l.pickupFloor}</span> : null}
            </Fact>
            <Fact label="A">
              <Stop stop={l.to} />
              {l.deliveryFloor ? <span className="block text-zinc-600">{l.deliveryFloor}</span> : null}
            </Fact>
            <Fact label="Distanza">
              {formatKm(l.distanceM)} · {formatDuration(l.durationS)}
            </Fact>
            {l.porters ? <Fact label="Facchini">{l.porters}</Fact> : null}
          </dl>
        </Section>
      ))}

      <Section title="Merce e veicolo">
        <dl className="space-y-2 text-sm">
          <Fact label="Veicolo richiesto">{job.vehicleTypeName}</Fact>
          {job.load.length ? <Fact label="Carico">{job.load.join(" · ")}</Fact> : null}
          {job.services.length ? (
            <Fact label="Servizi">
              <ul className="space-y-0.5">
                {job.services.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </Fact>
          ) : null}
        </dl>
      </Section>
    </>
  );
}

/** Facchinaggio (D164): one place, the work window, the team and the floor — no route, no vehicle. */
function PortersFacts({ job, porters }: { job: JobCard; porters: NonNullable<JobCard["porters"]> }) {
  return (
    <Section title="Facchinaggio">
      <dl className="space-y-2 text-sm">
        <Fact label="Luogo"><RouteList stops={job.stops} /></Fact>
        <Fact label="Inizio">
          {capitalize(romeWindow(job.pickupWindowStart, job.pickupWindowEnd))}
          {job.isUrgent ? <span className="ml-2 inline-block"><UrgentBadge /></span> : null}
        </Fact>
        <Fact label="Squadra">{porters.persons} facchini · {porters.hours} h di lavoro</Fact>
        {porters.floor ? <Fact label="Piano">{porters.floor}</Fact> : null}
        <Fact label="Veicolo">Non serve</Fact>
      </dl>
    </Section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** "Per te": total and the breakdown (transport / porters / packing), cents formatted only here. */
export function JobAmount({ amount }: { amount: JobCard["amount"] }) {
  const rows: [string, number][] = [
    ["Trasporto", amount.transportCents],
    ["Facchinaggio", amount.portersCents],
    ["Imballaggio", amount.packingCents],
  ];
  const shown = rows.filter(([, c]) => c > 0);
  return (
    <Section title="Compenso per te">
      <p className="text-3xl font-bold text-zinc-900">{formatCents(amount.totalCents)}</p>
      {shown.length > 1 ? (
        <dl className="mt-2 space-y-1 text-sm">
          {shown.map(([label, cents]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-zinc-600">{label}</dt>
              <dd className="font-medium">{formatCents(cents)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="mt-2 text-xs text-zinc-500">Importo che ricevi da Transigo per questa corsa.</p>
    </Section>
  );
}

/** Instead of the list: why the carrier gets no jobs, each reason with a link to fix it. */
export function JobBlockers({ blockers }: { blockers: JobBlocker[] }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <h2 className="font-semibold text-amber-900">Non puoi ancora vedere le corse disponibili</h2>
      <p className="mt-1 text-sm text-amber-900">Per ricevere corse devi sistemare:</p>
      <ul className="mt-3 space-y-2">
        {blockers.map((b) => (
          <li key={b.code} className="rounded-xl bg-white p-3 text-sm text-zinc-800">
            <p>{b.label}</p>
            <Link href={b.href} className="mt-1 inline-flex min-h-11 items-center font-semibold text-[#0B3B8C] underline">
              Cosa fare →
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Notice({ tone, children }: { tone: "info" | "error" | "success"; children: ReactNode }) {
  const cls = { info: "bg-blue-50 text-blue-900", error: "bg-red-50 text-red-800", success: "bg-green-50 text-green-800" }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-xl p-3 text-sm ${cls}`}>
      {children}
    </div>
  );
}

/**
 * After the "Rinuncia" deadline (or release_job too_late): no button, only how to reach Transigo. Phone and
 * e-mail come from settings.company_* (public data); without them the public contact page. "Segnala un
 * problema" (D39) comes with the delivery step.
 */
export function ContactTransigo({ text, phone, email }: { text: string; phone: string | null; email: string | null }) {
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <h2 className="font-semibold text-amber-900">Contatta Transigo</h2>
      <p className="mt-1 text-sm text-amber-900">{text}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {phone ? (
          <li>
            <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="inline-flex min-h-11 items-center font-semibold text-[#0B3B8C] underline">
              Chiama {phone}
            </a>
          </li>
        ) : null}
        {email ? (
          <li className="break-words">
            <span className="text-zinc-700">E-mail: </span>
            <a href={`mailto:${email}`} className="inline-flex min-h-11 items-center font-semibold break-all text-[#0B3B8C] underline">
              {email}
            </a>
          </li>
        ) : null}
        {!phone && !email ? (
          <li>
            <Link href="/contatti" className="inline-flex min-h-11 items-center font-semibold text-[#0B3B8C] underline">
              Scrivici dalla pagina Contatti →
            </Link>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/** Tab bar of "Le mie corse": links (work without JS), counters, ≥ 44 px, current tab marked. */
export function MyJobTabs({ tabs }: { tabs: { key: string; label: string; count: number; href: string; current: boolean }[] }) {
  return (
    <nav aria-label="Stato delle corse" className="grid grid-cols-3 gap-1 rounded-2xl bg-zinc-200/70 p-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          replace
          aria-current={t.current ? "page" : undefined}
          className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-1 text-sm font-semibold ${
            t.current ? "bg-white text-[#0B3B8C] shadow-sm" : "text-zinc-600 active:bg-white/60"
          }`}
        >
          <span className="truncate">{t.label}</span>
          <span
            className={`min-w-6 rounded-full px-1.5 text-center text-xs leading-5 ${t.current ? "bg-[#0B3B8C] text-white" : "bg-zinc-300 text-zinc-700"}`}
            aria-label={`${t.count} ${t.count === 1 ? "corsa" : "corse"}`}
          >
            {t.count}
          </span>
        </Link>
      ))}
    </nav>
  );
}
