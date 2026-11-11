import type { Metadata } from "next";
import Link from "next/link";
import { formatBp, formatCents } from "@/lib/pricing/money";
import { SERVICE_PAGES, SERVICES, type ServiceCode } from "@/lib/public/content";
import { publicAvailability, withVat, type PublicRates, type PublicSurcharge } from "@/lib/public/rates";
import { getPublicCatalog, getPublicRates } from "@/lib/public/server";
import { faqPageJsonLd, jsonLdString } from "@/lib/public/seo";
import { PortersCalculator, StorageCalculator } from "./calculators";
import { FaqList } from "./faq-list";
import { CheckList, PrimaryCta, SectionTitle, VehicleGrid } from "./ui";

// Shared template of the three service pages (/trasporto, /facchinaggio, /deposito; D151, D158). Texts from
// content.ts; indicative prices from the public customer rates of the active price list (D162) — net and
// with VAT, never carrier amounts. Exact prices come from the wizard (D76), with the VAT presentation of D3.

export function serviceMetadata(code: ServiceCode): Metadata {
  const d = SERVICE_PAGES[code];
  return { title: d.metaTitle, description: d.metaDescription, alternates: { canonical: `/${code}` } };
}

export async function ServicePage({ code }: { code: ServiceCode }) {
  const d = SERVICE_PAGES[code];
  const [catalog, rates] = await Promise.all([getPublicCatalog(), getPublicRates()]);
  const available = publicAvailability(rates)[code];

  return (
    <main className="flex-1">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(faqPageJsonLd(d.faqs)) }} />
      <section className="bg-brand-900 text-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <nav aria-label="Percorso" className="text-sm text-brand-200">
            <Link href="/#servizi" className="hover:text-white">Servizi</Link> <span aria-hidden="true">/</span> {d.title}
          </nav>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">{d.title}</h1>
          <p className="mt-5 max-w-2xl text-lg text-brand-100">{d.lead}</p>
          <div className="mt-8">
            {!available ? (
              <p className="max-w-2xl rounded-md bg-white/10 p-4 text-brand-50">
                Al momento questo servizio non è prenotabile online.{" "}
                <Link href="/contatti" className="font-semibold text-accent-300 underline hover:text-accent-200">Scrivici</Link> e ti aiutiamo noi.
              </p>
            ) : code === "trasporto" ? (
              <PrimaryCta />
            ) : (
              <PrimaryCta href="#prezzi">Calcola il prezzo indicativo</PrimaryCta>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <SectionTitle eyebrow="A cosa serve" title={`${d.title}: quando ti serve`} />
        <div className="mt-8 grid auto-rows-fr gap-5 md:grid-cols-3">
          {d.uses.map((u) => (
            <div key={u.title} className="rounded-xl border border-zinc-200 p-6">
              <h3 className="text-lg font-semibold text-brand-900">{u.title}</h3>
              <p className="mt-2 text-zinc-600">{u.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-12 px-4 pb-16 md:grid-cols-2">
        <div>
          <SectionTitle eyebrow="Il servizio" title="Cosa è incluso" />
          <div className="mt-6">
            <CheckList items={d.includes} />
          </div>
        </div>
        <div>
          <SectionTitle eyebrow="Prezzo" title="Da cosa dipende il prezzo" />
          <div className="mt-6">
            <CheckList items={d.pricing} />
          </div>
        </div>
      </section>

      {available && rates ? <Prices code={code} rates={rates} /> : null}

      {code === "trasporto" ? (
        <>
          {catalog.vehicles.length ? (
            <section className="mx-auto max-w-6xl px-4 pb-16">
              <SectionTitle eyebrow="Veicoli" title="I nostri veicoli" />
              <div className="mt-8">
                <VehicleGrid vehicles={catalog.vehicles} />
              </div>
            </section>
          ) : null}
          <Extras portersAvailable={catalog.portersAvailable} packingAvailable={catalog.packingAvailable} />
        </>
      ) : null}

      <section className="mx-auto max-w-3xl px-4 pb-16">
        <SectionTitle eyebrow="FAQ" title={`Domande su ${d.title.toLowerCase()}`} center />
        <div className="mt-8">
          <FaqList faqs={d.faqs} />
        </div>
        <div className="mt-6 text-center">
          <Link href="/domande-frequenti" className="text-sm font-medium text-brand-700 hover:text-brand-900">Tutte le domande →</Link>
        </div>
      </section>

      <section className="bg-brand-50">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <SectionTitle eyebrow="Altri servizi" title="Ti serve anche altro?" />
          <div className="mt-8 grid auto-rows-fr gap-5 sm:grid-cols-2">
            {SERVICES.filter((s) => s.code !== code).map((s) => (
              <Link key={s.code} href={s.href} className="group flex flex-col rounded-xl bg-white p-5 shadow-sm hover:shadow-md">
                <h3 className="text-lg font-semibold text-brand-900">{s.title}</h3>
                <p className="mt-2 flex-1 text-sm text-zinc-600">{s.summary}</p>
                <span className="mt-4 inline-block text-sm font-medium text-brand-700 group-hover:text-brand-900">Scopri di più →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

const th = "py-3 pr-4 font-medium";
const td = "py-3 pr-4 text-zinc-700";

function Money({ net, vatRateBp }: { net: number; vatRateBp: number }) {
  return (
    <>
      <td className={td}>{formatCents(net)}</td>
      <td className={td}>{formatCents(withVat(net, vatRateBp))}</td>
    </>
  );
}

function PriceTable({ caption, head, children }: { caption: string; head: string; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[26rem] text-left text-sm">
        <caption className="pb-2 text-left text-base font-semibold text-brand-900">{caption}</caption>
        <thead>
          <tr className="border-b border-zinc-200 text-zinc-500">
            <th scope="col" className={th}>{head}</th>
            <th scope="col" className={th}>IVA esclusa</th>
            <th scope="col" className={th}>IVA inclusa</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({ label, net, vatRateBp }: { label: React.ReactNode; net: number; vatRateBp: number }) {
  return (
    <tr className="border-b border-zinc-100">
      <th scope="row" className="py-3 pr-4 font-medium text-brand-900">{label}</th>
      <Money net={net} vatRateBp={vatRateBp} />
    </tr>
  );
}

const surchargeText = (s: PublicSurcharge) => (s.kind === "percent" ? `+${formatBp(s.percentBp)} %` : `+${formatCents(s.amountCents)}`);

/** Indicative price tables (D162) + the calculator for facchinaggio and deposito. */
function Prices({ code, rates }: { code: ServiceCode; rates: PublicRates }) {
  const vat = rates.vatRateBp;
  const t = rates.transport;
  const surcharges = [
    t.urgent ? `Urgenza (meno di ${t.urgentLeadHours} ore prima): ${surchargeText(t.urgent)}` : null,
    t.weekendHoliday ? `Sabato, domenica e festivi: ${surchargeText(t.weekendHoliday)}` : null,
  ].filter((x): x is string => !!x);

  return (
    <section id="prezzi" className="scroll-mt-20 bg-zinc-50">
      <div className="mx-auto max-w-6xl px-4 py-16">
        <SectionTitle eyebrow="Prezzi indicativi" title="Quanto costa" />
        <p className="mt-3 max-w-2xl text-zinc-600">
          Tariffe del listino in vigore. Il prezzo esatto è calcolato nella prenotazione e mostrato prima del pagamento: ai privati IVA inclusa, alle aziende IVA esclusa più IVA.
        </p>
        <div className={`mt-8 grid gap-10 ${code === "trasporto" ? "" : "lg:grid-cols-[3fr_2fr]"}`}>
          <div className="min-w-0 space-y-8">
            {code === "trasporto" ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-left text-sm">
                    <caption className="pb-2 text-left text-base font-semibold text-brand-900">Tariffa per veicolo</caption>
                    <thead>
                      <tr className="border-b border-zinc-200 text-zinc-500">
                        <th scope="col" className={th}>Veicolo</th>
                        <th scope="col" className={th}>Al km (IVA escl. / incl.)</th>
                        <th scope="col" className={th}>Prezzo minimo (IVA escl. / incl.)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.vehicles.map((v) => (
                        <tr key={v.vehicleTypeId} className="border-b border-zinc-100">
                          <th scope="row" className="py-3 pr-4 font-medium text-brand-900">{v.name}</th>
                          <td className={td}>{formatCents(v.perKmCents)} / {formatCents(withVat(v.perKmCents, vat))}</td>
                          <td className={td}>{formatCents(v.minCents)} / {formatCents(withVat(v.minCents, vat))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {t.floorNoElevatorCents || surcharges.length ? (
                  <div>
                    <h3 className="text-base font-semibold text-brand-900">Supplementi</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-700">
                      {t.floorNoElevatorCents ? (
                        <li>Ogni piano senza ascensore, al ritiro e alla consegna: {formatCents(t.floorNoElevatorCents)} ({formatCents(withVat(t.floorNoElevatorCents, vat))} IVA inclusa)</li>
                      ) : null}
                      {surcharges.map((s) => (
                        <li key={s}>{s} sul trasporto</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : null}

            {code === "facchinaggio" && rates.porters ? (
              <>
                <PriceTable caption="Facchinaggio" head="Voce">
                  <Row label="Un facchino, all'ora" net={rates.porters.perHourCents} vatRateBp={vat} />
                  {rates.porters.floorNoElevatorCents ? <Row label="Ogni piano senza ascensore" net={rates.porters.floorNoElevatorCents} vatRateBp={vat} /> : null}
                </PriceTable>
                <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700">
                  <li>Da {rates.porters.minPersons} a {rates.porters.maxPersons} facchini, minimo {rates.porters.minHours} ore per facchino.</li>
                  {surcharges.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </>
            ) : null}

            {code === "deposito" && rates.storage ? (
              <>
                {rates.storage.boxes.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[19rem] text-left text-sm">
                      <caption className="pb-2 text-left text-base font-semibold text-brand-900">Privati – box (IVA inclusa)</caption>
                      <thead>
                        <tr className="border-b border-zinc-200 text-zinc-500">
                          <th scope="col" className={th}>Box</th>
                          <th scope="col" className={th}>Volume</th>
                          <th scope="col" className={th}>Al giorno</th>
                          <th scope="col" className={th}>Al mese</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rates.storage.boxes.map((b) => (
                          <tr key={b.code} className="border-b border-zinc-100">
                            <th scope="row" className="py-3 pr-4 font-medium text-brand-900">{b.label}</th>
                            <td className={td}>{String(b.volumeM3).replace(".", ",")} m³</td>
                            <td className={td}>{formatCents(withVat(b.dayCents, vat))}</td>
                            <td className={td}>{formatCents(withVat(b.monthCents, vat))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-xs text-zinc-500">Mese = 30 giorni. Mesi interi a tariffa mensile, giorni restanti a tariffa giornaliera, mai più di un mese.</p>
                  </div>
                ) : null}
                {rates.storage.pallets ? (
                  <PriceTable caption="Aziende – pallet" head="Voce">
                    <Row label={`Pallet al giorno, fino a ${rates.storage.pallets.shortTermMaxDays} giorni`} net={rates.storage.pallets.shortDayCents} vatRateBp={vat} />
                    {rates.storage.pallets.longDayCents !== null ? (
                      <Row label={`Pallet al giorno, dal ${rates.storage.pallets.shortTermMaxDays + 1}° giorno`} net={rates.storage.pallets.longDayCents} vatRateBp={vat} />
                    ) : null}
                    {rates.storage.pallets.transshipmentCents !== null ? (
                      <Row label="Transbordo (in giornata, con il trasporto)" net={rates.storage.pallets.transshipmentCents} vatRateBp={vat} />
                    ) : null}
                  </PriceTable>
                ) : null}
              </>
            ) : null}
          </div>

          {code !== "trasporto" ? (
            <div className="min-w-0 rounded-xl bg-white p-5 shadow-sm ring-1 ring-black/5 sm:p-6">
              <h3 className="mb-4 text-lg font-semibold text-brand-900">Calcola il prezzo indicativo</h3>
              {code === "facchinaggio" ? <PortersCalculator rates={rates} /> : <StorageCalculator rates={rates} />}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Transport extras: porters and packing (Imballaggio is an extra of the transport, D151). */
function Extras({ portersAvailable, packingAvailable }: { portersAvailable: boolean; packingAvailable: boolean }) {
  return (
    <section className="mx-auto max-w-6xl px-4 pb-16">
      <SectionTitle eyebrow="Servizi aggiuntivi" title="Da aggiungere al trasporto" />
      <div className="mt-8 grid auto-rows-fr gap-5 md:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 p-6">
          <h3 className="text-lg font-semibold text-brand-900">Facchini</h3>
          <p className="mt-2 text-zinc-600">
            Per caricare e scaricare: scegli la dimensione del carico, persone e ore incluse sono già nel prezzo. Puoi aggiungere facchini fino a 4.
            {portersAvailable ? null : " Al momento non disponibile online."}
          </p>
        </div>
        <div id="imballaggio" className="scroll-mt-20 rounded-xl border border-zinc-200 p-6">
          <h3 className="text-lg font-semibold text-brand-900">Imballaggio</h3>
          <p className="mt-2 text-zinc-600">
            Imballiamo i tuoi oggetti al ritiro, prima del carico. Il prezzo dipende dal numero di colli ed è indicato nel preventivo.
            {packingAvailable ? null : " Al momento non disponibile online."}
          </p>
        </div>
      </div>
    </section>
  );
}
