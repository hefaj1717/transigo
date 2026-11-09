import type { Metadata } from "next";
import Link from "next/link";
import { PageHero, Steps } from "@/components/site/page-hero";
import { PrimaryCta, SectionTitle } from "@/components/site/ui";
import { CARRIER_STEPS, CUSTOMER_STEPS } from "@/lib/public/content";

export const metadata: Metadata = {
  title: "Come funziona – Transigo",
  description: "Dal preventivo online alla consegna con firma e foto: come prenotare un trasporto con Transigo e come lavorare con noi come trasportatore.",
};

// "Come funziona" (spec section 5): customer journey in detail + carrier side in short.
export default function Page() {
  return (
    <main className="flex-1">
      <PageHero title="Come funziona" lead="Prezzo online, pagamento sicuro e trasportatori verificati. Ecco cosa succede dalla prenotazione alla consegna.">
        <PrimaryCta />
      </PageHero>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <SectionTitle eyebrow="Per chi spedisce" title="Dalla prenotazione alla consegna" />
        <div className="mt-8">
          <Steps steps={CUSTOMER_STEPS} />
        </div>
        <p className="mt-8 text-sm text-zinc-600">
          Il preventivo è gratuito e senza registrazione. Hai dubbi?{" "}
          <Link href="/domande-frequenti" className="font-medium text-brand-700 underline hover:text-brand-900">Leggi le domande frequenti</Link>.
        </p>
      </section>

      <section className="bg-accent-50">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <SectionTitle eyebrow="Per i trasportatori" title="Lavora con noi con la tua partita IVA" />
          <div className="mt-8">
            <Steps steps={CARRIER_STEPS} tone="accent" />
          </div>
          <Link href="/diventa-partner" className="mt-8 inline-block rounded-md bg-accent-600 px-5 py-3 font-semibold text-white hover:bg-accent-700">
            Diventa partner
          </Link>
        </div>
      </section>
    </main>
  );
}
