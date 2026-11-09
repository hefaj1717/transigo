import type { Metadata } from "next";
import Link from "next/link";
import { FAQS, HOME_FAQ_COUNT, HOW_IT_WORKS, SERVICES } from "@/lib/public/content";
import { getPublicCatalog } from "@/lib/public/server";
import { Check, SectionTitle, VehicleGrid } from "@/components/site/ui";
import { HeroForm } from "./hero-form";

export const metadata: Metadata = {
  title: "Transigo – Trasporti, facchinaggio e deposito merci con prezzo online",
  description: "Calcola subito il prezzo del tuo trasporto, prenota e paga online. Trasportatori verificati, facchinaggio, imballaggio e deposito merci.",
};

// Home page (spec section 5): hero with the mini form → wizard, services, how it works, vehicles,
// "Diventa partner", FAQ. Everything is static or cached — the page is prerendered.
export default async function Home() {
  const catalog = await getPublicCatalog();

  return (
    <main className="flex-1">
      {/* Hero */}
      <section className="bg-brand-900 text-white">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 lg:grid-cols-2 lg:py-20">
          <div>
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
              Il tuo trasporto, <span className="text-accent-400">prezzo subito</span>.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-brand-100">
              Trasporti, facchinaggio, imballaggio e deposito merci. Calcola il prezzo online, prenota in pochi minuti e
              segui la consegna fino alla firma.
            </p>
            <ul className="mt-6 space-y-2 text-brand-100">
              {["Prezzo chiaro prima di pagare", "Trasportatori verificati", "Fattura elettronica per privati e aziende"].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <Check /> {t}
                </li>
              ))}
            </ul>
          </div>
          <HeroForm />
        </div>
      </section>

      {/* Services */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <SectionTitle eyebrow="Servizi" title="Tutto quello che serve per spostare le tue cose" />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {SERVICES.map((s) => (
            <Link key={s.code} href={`/servizi/${s.code}`} className="group rounded-xl border border-zinc-200 p-5 hover:border-brand-300 hover:shadow-md">
              <h3 className="text-lg font-semibold text-brand-900">{s.title}</h3>
              <p className="mt-2 text-sm text-zinc-600">{s.summary}</p>
              <span className="mt-4 inline-block text-sm font-medium text-brand-700 group-hover:text-brand-900">Scopri di più →</span>
            </Link>
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
        <div className="mt-8 divide-y divide-zinc-200 rounded-xl border border-zinc-200">
          {FAQS.slice(0, HOME_FAQ_COUNT).map((f) => (
            <details key={f.q} className="group p-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-brand-900">
                {f.q}
                <span className="text-brand-500 transition group-open:rotate-45" aria-hidden="true">+</span>
              </summary>
              <p className="mt-3 text-sm text-zinc-600">{f.a}</p>
            </details>
          ))}
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
