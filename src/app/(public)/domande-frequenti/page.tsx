import type { Metadata } from "next";
import Link from "next/link";
import { FaqList } from "@/components/site/faq-list";
import { PageHero } from "@/components/site/page-hero";
import { FAQ_GROUPS, FAQS } from "@/lib/public/content";
import { faqPageJsonLd, jsonLdString } from "@/lib/public/seo";

export const metadata: Metadata = {
  title: "Domande frequenti – Transigo",
  description: "Prezzi, pagamento, fatture, consegna e lavoro come trasportatore partner: le risposte alle domande più frequenti.",
};

// FAQ page (spec section 5) with schema.org FAQPage structured data.
export default function Page() {
  return (
    <main className="flex-1">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(faqPageJsonLd(FAQS)) }} />
      <PageHero title="Domande frequenti" lead="Le risposte alle domande più comuni su prenotazione, pagamento e servizio." />
      <div className="mx-auto max-w-3xl space-y-12 px-4 py-16">
        <nav aria-label="Argomenti" className="flex flex-wrap gap-2">
          {FAQ_GROUPS.map((g) => (
            <a key={g.code} href={`#${g.code}`} className="rounded-full border border-brand-200 px-4 py-1.5 text-sm font-medium text-brand-800 hover:bg-brand-50">
              {g.title}
            </a>
          ))}
        </nav>
        {FAQ_GROUPS.map((g) => (
          <section key={g.code} id={g.code} className="scroll-mt-24">
            <h2 className="mb-4 text-2xl font-bold text-brand-900">{g.title}</h2>
            <FaqList faqs={FAQS.filter((f) => f.group === g.code)} />
          </section>
        ))}
        <p className="rounded-xl bg-brand-50 p-6 text-zinc-700">
          Non hai trovato la risposta?{" "}
          <Link href="/contatti" className="font-semibold text-brand-800 underline hover:text-brand-900">Scrivici</Link>.
        </p>
      </div>
    </main>
  );
}
