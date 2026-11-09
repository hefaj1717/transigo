import type { Metadata } from "next";
import Link from "next/link";
import { CheckList, PrimaryCta } from "@/components/site/ui";
import { SERVICE_DETAILS, SERVICES } from "@/lib/public/content";

export const metadata: Metadata = {
  title: "Servizi – Transigo",
  description: "Trasporto, facchinaggio, imballaggio e deposito merci: combina i servizi in un'unica prenotazione con prezzo online.",
};

// Services overview (spec section 5). Static page — details per service on /servizi/…
export default function Page() {
  return (
    <main className="flex-1">
      <section className="bg-brand-900 text-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">I nostri servizi</h1>
          <p className="mt-5 max-w-2xl text-lg text-brand-100">
            Trasporto, facchinaggio, imballaggio e deposito merci. Scegli quello che ti serve e combinali in un&apos;unica prenotazione: il prezzo si aggiorna mentre scegli.
          </p>
          <div className="mt-8">
            <PrimaryCta />
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-4 py-16 md:grid-cols-2">
        {SERVICES.map((s) => (
          <article key={s.code} className="flex flex-col rounded-xl border border-zinc-200 p-6">
            <h2 className="text-2xl font-bold text-brand-900">{s.title}</h2>
            <p className="mt-2 text-zinc-600">{s.summary}</p>
            <div className="mt-5 flex-1 text-sm">
              <CheckList items={SERVICE_DETAILS[s.code].includes.slice(0, 3)} />
            </div>
            <Link href={`/servizi/${s.code}`} className="mt-6 inline-block self-start rounded-md border border-brand-200 px-4 py-2 text-sm font-semibold text-brand-800 hover:bg-brand-50">
              Scopri {s.title.toLowerCase()}
            </Link>
          </article>
        ))}
      </section>
    </main>
  );
}
