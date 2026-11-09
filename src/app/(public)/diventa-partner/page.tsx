import type { Metadata } from "next";
import Link from "next/link";
import { FaqList } from "@/components/site/faq-list";
import { PageHero, Steps } from "@/components/site/page-hero";
import { Check, SectionTitle } from "@/components/site/ui";
import { CARRIER_STEPS, FAQS, PARTNER_BENEFITS } from "@/lib/public/content";
import { partnerDocuments } from "@/lib/public/partner";

export const metadata: Metadata = {
  title: "Diventa partner – Transigo",
  description: "Sei un trasportatore con partita IVA? Ricevi corse nella tua zona, scegli quelle che ti convengono e vieni pagato dopo ogni consegna.",
};

// "Diventa partner" (spec section 5): carrier side (green). Registration: /registrati?tipo=padroncino.
export default function Page() {
  const docs = partnerDocuments();
  const company = docs.filter((d) => !d.perVehicle);
  const vehicle = docs.filter((d) => d.perVehicle);

  return (
    <main className="flex-1">
      <PageHero
        tone="accent"
        title="Diventa partner"
        lead="Sei un trasportatore con partita IVA? Ricevi corse nella tua zona direttamente sul telefono, scegli quelle che ti convengono e vieni pagato dopo ogni consegna."
      >
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/registrati?tipo=padroncino" className="rounded-md bg-white px-5 py-3 font-semibold text-accent-800 hover:bg-accent-50">Registrati come partner</Link>
          <Link href="/accedi" className="font-medium text-white underline hover:text-accent-100">Hai già un account? Accedi</Link>
        </div>
      </PageHero>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <SectionTitle eyebrow="Perché Transigo" title="Lavori quando vuoi, sai sempre quanto guadagni" />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {PARTNER_BENEFITS.map((b) => (
            <div key={b.title} className="rounded-xl border border-zinc-200 p-5">
              <h3 className="text-lg font-semibold text-brand-900">{b.title}</h3>
              <p className="mt-2 text-sm text-zinc-600">{b.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-accent-50">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <SectionTitle eyebrow="Come funziona" title="Dalla registrazione al primo pagamento" />
          <div className="mt-8">
            <Steps steps={CARRIER_STEPS} tone="accent" />
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-12 px-4 py-16 md:grid-cols-2">
        <div>
          <SectionTitle eyebrow="Requisiti" title="Cosa ti serve" />
          <ul className="mt-6 space-y-3 text-zinc-700">
            <Req>Partita IVA e dati aziendali (sede, PEC o codice SDI)</Req>
            <Req>Almeno un veicolo</Req>
            <Req>Un conto per ricevere i pagamenti (IBAN) e la verifica dell&apos;identità, al momento dell&apos;attivazione dei pagamenti</Req>
          </ul>
        </div>
        <div>
          <SectionTitle eyebrow="Documenti" title="Da caricare nell'app" />
          <DocList title="Per l'azienda" docs={company} />
          <DocList title="Per ogni veicolo" docs={vehicle} />
          <p className="mt-4 text-sm text-zinc-500">Li fotografi o li carichi in PDF direttamente dal telefono.</p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 pb-16">
        <SectionTitle eyebrow="FAQ" title="Domande dei trasportatori" />
        <div className="mt-8">
          <FaqList faqs={FAQS.filter((f) => f.group === "trasportatori")} />
        </div>
      </section>

      <section className="bg-accent-700 text-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-4 py-14 text-center">
          <h2 className="text-2xl font-bold sm:text-3xl">Pronto a ricevere corse?</h2>
          <Link href="/registrati?tipo=padroncino" className="rounded-md bg-white px-6 py-3 font-semibold text-accent-800 hover:bg-accent-50">Registrati come partner</Link>
        </div>
      </section>
    </main>
  );
}

function Req({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5"><Check className="text-accent-600" /></span>
      <span>{children}</span>
    </li>
  );
}

function DocList({ title, docs }: { title: string; docs: { label: string; required: boolean }[] }) {
  if (!docs.length) return null;
  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      <ul className="mt-3 space-y-3 text-zinc-700">
        {docs.map((d) => (
          <Req key={d.label}>
            {d.label}
            {d.required ? null : <span className="text-zinc-500"> (se disponibile)</span>}
          </Req>
        ))}
      </ul>
    </div>
  );
}
