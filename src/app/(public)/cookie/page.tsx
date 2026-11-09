import type { Metadata } from "next";
import Link from "next/link";
import { PageHero } from "@/components/site/page-hero";
import { BROWSER_STORAGE } from "@/lib/public/cookies";

export const metadata: Metadata = {
  title: "Cookie policy – Transigo",
  description: "Quali cookie e dati salva Transigo nel tuo browser: solo strumenti tecnici, nessun cookie di profilazione.",
};

// Cookie policy (spec section 5, D126). Factual list of what is stored today; the full legal text arrives in
// Stage 8 together with Termini and Privacy.
export default function Page() {
  return (
    <main className="flex-1">
      <PageHero title="Cookie policy" lead="Usiamo solo cookie e strumenti tecnici necessari al funzionamento del sito. Nessun cookie di profilazione o di statistica." />
      <div className="mx-auto max-w-3xl space-y-8 px-4 py-16 text-zinc-700">
        <section>
          <h2 className="text-2xl font-bold text-brand-900">Cosa salviamo nel tuo browser</h2>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-zinc-500">
                  <th scope="col" className="py-3 pr-4 font-medium">Nome</th>
                  <th scope="col" className="py-3 pr-4 font-medium">Tipo</th>
                  <th scope="col" className="py-3 pr-4 font-medium">Finalità</th>
                  <th scope="col" className="py-3 font-medium">Durata</th>
                </tr>
              </thead>
              <tbody>
                {BROWSER_STORAGE.map((c) => (
                  <tr key={c.name} className="border-b border-zinc-100 align-top">
                    <th scope="row" className="py-3 pr-4 font-mono text-xs font-normal text-brand-900">{c.name}</th>
                    <td className="py-3 pr-4">{c.kind}</td>
                    <td className="py-3 pr-4">{c.purpose}</td>
                    <td className="py-3">{c.duration}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="space-y-3">
          <h2 className="text-2xl font-bold text-brand-900">Pagamenti</h2>
          <p>Il pagamento avviene sulla pagina sicura del nostro fornitore di pagamenti, che può usare propri cookie tecnici e antifrode secondo la sua informativa.</p>
        </section>
        <section className="space-y-3">
          <h2 className="text-2xl font-bold text-brand-900">Come gestirli</h2>
          <p>Puoi cancellare cookie e dati salvati dalle impostazioni del browser. Senza il cookie di sessione non è possibile restare connessi all&apos;account.</p>
          <p>
            Per sapere come trattiamo i tuoi dati personali leggi l&apos;<Link href="/privacy" className="font-medium text-brand-700 underline">informativa sulla privacy</Link>.
          </p>
        </section>
        <p className="rounded-xl bg-brand-50 p-4 text-sm">Testo in aggiornamento: la versione completa sarà pubblicata insieme ai Termini e condizioni.</p>
      </div>
    </main>
  );
}
