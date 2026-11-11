import type { Metadata } from "next";
import Link from "next/link";
import { PageHero } from "@/components/site/page-hero";
import { Suspense } from "react";
import { getCompanyInfo, getPublicRates } from "@/lib/public/server";
import { ContactForm } from "@/components/contact-form";
import { sendContactAction } from "./actions";
import { RequestContactForm } from "./request-form";

export const metadata: Metadata = {
  title: "Contatti – Transigo",
  description: "Scrivici per informazioni su trasporti, facchinaggio, imballaggio e deposito merci, o per collaborare con noi.",
};

// Contact page (spec section 5, D125): form saved through submit_contact_request (rate limit per IP),
// notification to the team without personal data. Company contacts from settings (cached).
// ?servizio=… from the Facchini / Deposito calculators pre-fills the message (D162); the query string is read
// in the browser, so the page stays prerendered.
export default async function Page() {
  const [company, rates] = await Promise.all([getCompanyInfo(), getPublicRates()]);
  return (
    <main className="flex-1">
      <PageHero title="Contatti" lead="Hai una domanda o un trasporto particolare? Scrivici: ti rispondiamo al più presto." />
      <div className="mx-auto grid max-w-6xl gap-12 px-4 py-16 lg:grid-cols-[2fr_1fr]">
        <section aria-labelledby="form-title">
          <h2 id="form-title" className="mb-6 text-2xl font-bold text-brand-900">Scrivici</h2>
          <Suspense fallback={<ContactForm action={sendContactAction} />}>
            <RequestContactForm rates={rates} />
          </Suspense>
        </section>
        <aside className="space-y-6">
          <div className="rounded-xl bg-brand-50 p-6">
            <h2 className="text-lg font-semibold text-brand-900">Vuoi un prezzo?</h2>
            <p className="mt-2 text-sm text-zinc-700">Il preventivo online è immediato e senza registrazione.</p>
            <Link href="/prenota" className="mt-4 inline-block rounded-md bg-accent-600 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-700">Calcola il prezzo</Link>
          </div>
          <div className="rounded-xl border border-zinc-200 p-6 text-sm text-zinc-700">
            <h2 className="text-lg font-semibold text-brand-900">{company.name}</h2>
            <ul className="mt-3 space-y-1">
              {company.registeredOffice ? <li>Sede legale: {company.registeredOffice}</li> : null}
              {company.vatNumber ? <li>P.IVA {company.vatNumber}</li> : null}
              {company.email ? <li>E-mail: <a href={`mailto:${company.email}`} className="text-brand-700 underline">{company.email}</a></li> : null}
              {company.phone ? <li>Telefono: <a href={`tel:${company.phone.replace(/\s+/g, "")}`} className="text-brand-700 underline">{company.phone}</a></li> : null}
              {company.pec ? <li>PEC: {company.pec}</li> : null}
            </ul>
            <p className="mt-4">
              Domande frequenti: <Link href="/domande-frequenti" className="text-brand-700 underline">leggi le risposte</Link>.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
