import Link from "next/link";
import { LEGAL_LINKS, NAV_LINKS, SERVICES } from "@/lib/public/content";
import { getCompanyInfo } from "@/lib/public/server";
import { Logo } from "./logo";

// Public site footer. Legal data (ragione sociale, sede legale, P.IVA) is required on the website — it comes
// from `settings` (company_*); a missing value is simply not shown until the owner fills it.
export async function SiteFooter() {
  const company = await getCompanyInfo();
  const heading = "text-sm font-semibold uppercase tracking-wide text-brand-200";
  const link = "text-sm text-brand-100 hover:text-white";

  return (
    <footer className="bg-brand-900 text-brand-100">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Logo onDark />
          <p className="mt-3 text-sm text-brand-200">Trasporti, facchinaggio, imballaggio e deposito merci. Prezzo online, pagamento sicuro.</p>
        </div>
        <div>
          <h2 className={heading}>Servizi</h2>
          <ul className="mt-3 space-y-2">
            {SERVICES.map((s) => (
              <li key={s.code}>
                <Link href={`/servizi/${s.code}`} className={link}>{s.title}</Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className={heading}>Transigo</h2>
          <ul className="mt-3 space-y-2">
            {NAV_LINKS.filter((l) => l.href !== "/servizi").map((l) => (
              <li key={l.href}>
                <Link href={l.href} className={link}>{l.label}</Link>
              </li>
            ))}
            <li>
              <Link href="/diventa-partner" className="text-sm font-medium text-accent-300 hover:text-accent-200">Diventa partner</Link>
            </li>
          </ul>
        </div>
        <div>
          <h2 className={heading}>Contatti</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {company.email ? <li><a href={`mailto:${company.email}`} className={link}>{company.email}</a></li> : null}
            {company.phone ? <li><a href={`tel:${company.phone.replace(/\s+/g, "")}`} className={link}>{company.phone}</a></li> : null}
            <li><Link href="/contatti" className={link}>Scrivici</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-brand-800">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 text-xs text-brand-200 lg:flex-row lg:items-start lg:justify-between">
          <address className="not-italic leading-relaxed">
            <span className="font-semibold text-brand-100">{company.name}</span>
            {company.registeredOffice ? <> · Sede legale: {company.registeredOffice}</> : null}
            {company.vatNumber ? <> · P.IVA {company.vatNumber}</> : null}
            {company.pec ? <> · PEC {company.pec}</> : null}
          </address>
          <nav aria-label="Note legali" className="flex flex-wrap gap-x-4 gap-y-2">
            {LEGAL_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="hover:text-white">{l.label}</Link>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
