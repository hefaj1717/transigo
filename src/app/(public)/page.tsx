import type { Metadata } from "next";
import Link from "next/link";
import { AUDIENCES, HOME_FAQS, HOW_IT_WORKS, SERVICES } from "@/lib/public/content";
import { getPublicCatalog, getPublicRates } from "@/lib/public/server";
import { formatCents } from "@/lib/pricing/money";
import { FaqList } from "@/components/site/faq-list";
import { Check, SectionTitle, VehicleGrid } from "@/components/site/ui";
import { HeroTabs } from "./hero-tabs";

export const metadata: Metadata = {
  title: "Transigo – Trasporti, facchinaggio e deposito merci con prezzo online",
  description: "Calcola subito il prezzo del tuo trasporto, prenota e paga online. Trasportatori verificati, facchinaggio, imballaggio e deposito merci.",
};

// Home page (spec section 5, D151): hero with one tab per service (route form → wizard, Facchini and
// Deposito calculators with public rates, D162), the three services, "Per privati" / "Per aziende", how it
// works, vehicles, "Diventa partner", FAQ. Everything is static or cached — the page is prerendered.
export default async function Home() {
  const [catalog, rates] = await Promise.all([getPublicCatalog(), getPublicRates()]);

  return (
    <main className="flex-1">
      {/* Hero */}
      <section className="bg-brand-900 text-white">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 lg:grid-cols-2 lg:py-20">
          <div>
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
              Trasporto, facchini e deposito. <span className="text-accent-400">Prezzo subito</span>.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-brand-100">
              Sposta le tue cose, fatti aiutare dai facchini o lascia la merce nel nostro magazzino. Calcola il prezzo
              online e prenota in pochi minuti.
            </p>
            <ul className="mt-6 space-y-2 text-brand-100">
              {["Prezzo chiaro prima di pagare", "Trasportatori verificati", "Fattura elettronica per privati e aziende"].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <Check /> {t}
                </li>
              ))}
            </ul>
          </div>
          <HeroTabs rates={rates} />
        </div>
      </section>

      {/* Services: three equal cards (D151) */}
      <section id="servizi" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16">
        <SectionTitle eyebrow="Servizi" title="Tre servizi, una sola piattaforma" />
        <div className="mt-8 grid auto-rows-fr gap-5 md:grid-cols-3">
          {SERVICES.map((s) => (
            <Link key={s.code} href={s.href} className="group flex flex-col rounded-xl border border-zinc-200 p-6 hover:border-brand-300 hover:shadow-md">
              <h3 className="text-xl font-semibold text-brand-900">{s.title}</h3>
              <p className="mt-2 flex-1 text-zinc-600">{s.summary}</p>
              <span className="mt-5 inline-block text-sm font-medium text-brand-700 group-hover:text-brand-900">Scopri di più →</span>
            </Link>
          ))}
        </div>
      </section>

      {/* Per privati / Per aziende */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="grid gap-5 md:grid-cols-2">
          {AUDIENCES.map((a) => (
            <div key={a.title} className="rounded-xl bg-brand-900 p-6 text-white sm:p-8">
              <h2 className="text-2xl font-bold">{a.title}</h2>
              <p className="mt-2 text-brand-100">{a.lead}</p>
              <ul className="mt-5 space-y-3">
                {a.points.map((t) => (
                  <li key={t} className="flex items-start gap-3 text-brand-50">
                    <span className="mt-0.5"><Check /></span>
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="bg-brand-50">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <SectionTitle eyebrow="Come funziona" title="Tre passi, tutto online" />
          <ol className="mt-8 grid gap-6 md:grid-cols-3">
            {HOW_IT_WORKS.map((s, i) => (
              <li key={s.title} className="rounded-xl bg-white p-6 shadow-sm">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-800 text-lg font-bold text-white">{i + 1}</span>
                <h3 className="mt-4 text-lg font-semibold text-brand-900">{s.title}</h3>
                <p className="mt-2 text-sm text-zinc-600">{s.text}</p>
              </li>
            ))}
          </ol>
          <Link href="/come-funziona" className="mt-8 inline-block text-sm font-medium text-brand-700 hover:text-brand-900">Maggiori dettagli →</Link>
        </div>
      </section>

      {/* Vehicles */}
      {catalog.vehicles.length ? (
        <section className="mx-auto max-w-6xl px-4 py-16">
          <SectionTitle eyebrow="Veicoli" title="Il veicolo giusto per ogni carico" />
          <p className="mt-3 max-w-2xl text-zinc-600">Nella prenotazione ti consigliamo il veicolo adatto in base a peso, misure e numero di pallet.</p>
          <div className="mt-8">
            <VehicleGrid vehicles={catalog.vehicles} />
          </div>
        </section>
      ) : null}

      {/* Facchini and warehouses (owner feedback 2026-11-13: not only vehicles) */}
      {rates?.porters || catalog.warehouses.length ? (
        <section className="bg-zinc-50">
          <div className="mx-auto grid max-w-6xl gap-12 px-4 py-16 md:grid-cols-2">
            {rates?.porters ? (
              <div>
                <SectionTitle eyebrow="Facchini" title="Squadre di facchini" />
                <p className="mt-3 text-zinc-600">
                  Per traslochi, carico e scarico o per spostare mobili e merce dentro casa o in ufficio. Scegli quante persone e per quante ore.
                </p>
                <dl className="mt-6 grid grid-cols-2 gap-4">
                  <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-black/5">
                    <dt className="text-sm text-zinc-500">Squadra</dt>
                    <dd className="mt-1 text-xl font-semibold text-brand-900">
                      {rates.porters.minPersons === rates.porters.maxPersons ? rates.porters.minPersons : `${rates.porters.minPersons}–${rates.porters.maxPersons}`} facchini
                    </dd>
                  </div>
                  <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-black/5">
                    <dt className="text-sm text-zinc-500">A persona, all&apos;ora</dt>
                    <dd className="mt-1 text-xl font-semibold text-brand-900">{formatCents(rates.porters.perHourCents)} <span className="text-sm font-medium text-zinc-500">+ IVA</span></dd>
                  </div>
                </dl>
                <Link href="/facchinaggio" className="mt-6 inline-block text-sm font-medium text-brand-700 hover:text-brand-900">Scopri il facchinaggio →</Link>
              </div>
            ) : null}
            {catalog.warehouses.length ? (
              <div>
                <SectionTitle eyebrow="Magazzini" title="I nostri magazzini" />
                <p className="mt-3 text-zinc-600">Box per i privati e posti pallet per le aziende. Porti tu la merce o la ritiriamo e la riconsegniamo noi.</p>
                <ul className="mt-6 grid gap-4 sm:grid-cols-2">
                  {catalog.warehouses.map((w) => (
                    <li key={`${w.name}|${w.city}`} className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-black/5">
                      <p className="text-lg font-semibold text-brand-900">{w.city} <span className="text-sm font-medium text-zinc-500">({w.province})</span></p>
                      <p className="mt-1 text-sm text-zinc-600">{w.name}</p>
                    </li>
                  ))}
                </ul>
                <Link href="/deposito" className="mt-6 inline-block text-sm font-medium text-brand-700 hover:text-brand-900">Scopri il deposito →</Link>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Partner CTA (green = carrier side) */}
      <section className="bg-accent-700 text-white">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-14 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-2xl font-bold sm:text-3xl">Sei un trasportatore con partita IVA?</h2>
            <p className="mt-2 max-w-2xl text-accent-50">Ricevi corse nella tua zona direttamente nell&apos;app, scegli quelle che ti convengono e vieni pagato dopo ogni consegna.</p>
          </div>
          <Link href="/diventa-partner" className="shrink-0 rounded-md bg-white px-5 py-3 font-semibold text-accent-800 hover:bg-accent-50">Diventa partner</Link>
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-4 py-16">
        <SectionTitle eyebrow="FAQ" title="Domande frequenti" center />
        <div className="mt-8">
          <FaqList faqs={HOME_FAQS} />
        </div>
        <div className="mt-6 text-center">
          <Link href="/domande-frequenti" className="text-sm font-medium text-brand-700 hover:text-brand-900">Tutte le domande →</Link>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-brand-800 text-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-4 py-14 text-center">
          <h2 className="text-2xl font-bold sm:text-3xl">Pronto a partire?</h2>
          <Link href="/prenota" className="rounded-md bg-accent-500 px-6 py-3 font-semibold text-white hover:bg-accent-600">Calcola il prezzo</Link>
        </div>
      </section>
    </main>
  );
}
