import type { Metadata } from "next";
import Link from "next/link";
import { SERVICE_DETAILS, SERVICES, type ServiceCode } from "@/lib/public/content";
import { getPublicCatalog, type PublicCatalog } from "@/lib/public/server";
import { serviceAvailable, serviceTexts } from "@/lib/public/services";
import { CheckList, numberIt, PrimaryCta, SectionTitle, VehicleGrid } from "./ui";

// Shared template of the four service pages (/servizi/…, spec section 5). Texts come from content.ts, live
// details (vehicles, porter packages, storage limit) from the active price list — capacities and rules only,
// never prices (prices are shown by the wizard, D76, with the right VAT presentation, D3).

export function serviceMetadata(code: ServiceCode): Metadata {
  const d = SERVICE_DETAILS[code];
  return { title: `${d.title} – Transigo`, description: d.metaDescription };
}

export async function ServicePage({ code }: { code: ServiceCode }) {
  const d = SERVICE_DETAILS[code];
  const catalog = await getPublicCatalog();
  const available = serviceAvailable(code, catalog);
  const { includes, pricing } = serviceTexts(code, catalog);

  return (
    <main className="flex-1">
      <section className="bg-brand-900 text-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <nav aria-label="Percorso" className="text-sm text-brand-200">
            <Link href="/servizi" className="hover:text-white">Servizi</Link> <span aria-hidden="true">/</span> {d.title}
          </nav>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">{d.title}</h1>
          <p className="mt-5 max-w-2xl text-lg text-brand-100">{d.lead}</p>
          <div className="mt-8">
            {available ? (
              <PrimaryCta />
            ) : (
              <p className="max-w-2xl rounded-md bg-white/10 p-4 text-brand-50">
                Al momento questo servizio non è prenotabile online.{" "}
                <Link href="/contatti" className="font-semibold text-accent-300 underline hover:text-accent-200">Scrivici</Link> e ti aiutiamo noi.
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-12 px-4 py-16 md:grid-cols-2">
        <div>
          <SectionTitle eyebrow="Il servizio" title="Cosa è incluso" />
          <div className="mt-6">
            <CheckList items={includes} />
          </div>
        </div>
        <div>
          <SectionTitle eyebrow="Prezzo" title="Da cosa dipende il prezzo" />
          <div className="mt-6">
            <CheckList items={pricing} />
          </div>
          <p className="mt-6 text-sm text-zinc-500">Il prezzo esatto è calcolato nella prenotazione e mostrato prima del pagamento, senza costi nascosti.</p>
        </div>
      </section>

      <Details code={code} catalog={catalog} />

      <section className="bg-brand-50">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <SectionTitle eyebrow="Altri servizi" title="Puoi combinarli in un'unica prenotazione" />
          <div className="mt-8 grid gap-5 sm:grid-cols-3">
            {SERVICES.filter((s) => s.code !== code).map((s) => (
              <Link key={s.code} href={`/servizi/${s.code}`} className="group rounded-xl bg-white p-5 shadow-sm hover:shadow-md">
                <h3 className="text-lg font-semibold text-brand-900">{s.title}</h3>
                <p className="mt-2 text-sm text-zinc-600">{s.summary}</p>
                <span className="mt-4 inline-block text-sm font-medium text-brand-700 group-hover:text-brand-900">Scopri di più →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

/** Live details per service, only when the price list provides them. */
function Details({ code, catalog }: { code: ServiceCode; catalog: PublicCatalog }) {
  if (code === "trasporto" && catalog.vehicles.length) {
    return (
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <SectionTitle eyebrow="Veicoli" title="I nostri veicoli" />
        <div className="mt-8">
          <VehicleGrid vehicles={catalog.vehicles} />
        </div>
      </section>
    );
  }
  if (code === "facchinaggio" && catalog.porterPackages.length) {
    return (
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <SectionTitle eyebrow="Dimensione del carico" title="Persone e ore incluse" />
        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-zinc-500">
                <th scope="col" className="py-3 pr-4 font-medium">Carico</th>
                <th scope="col" className="py-3 pr-4 font-medium">Facchini</th>
                <th scope="col" className="py-3 font-medium">Ore incluse</th>
              </tr>
            </thead>
            <tbody>
              {catalog.porterPackages.map((p) => (
                <tr key={p.code} className="border-b border-zinc-100">
                  <th scope="row" className="py-3 pr-4 font-medium text-brand-900">{p.label}</th>
                  <td className="py-3 pr-4 text-zinc-700">{p.persons}</td>
                  <td className="py-3 text-zinc-700">{numberIt.format(p.includedHours)} h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }
  if (code === "deposito-merci" && catalog.storageAvailable && catalog.warehouseCity) {
    return (
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <p className="rounded-xl border border-zinc-200 p-5 text-zinc-700">
          Il nostro magazzino si trova a <span className="font-semibold text-brand-900">{catalog.warehouseCity}</span>. Nella prenotazione scegli la data e la fascia oraria della consegna dal magazzino.
        </p>
      </section>
    );
  }
  return null;
}
