import Link from "next/link";
import { NAV_LINKS } from "@/lib/public/content";
import { AccountLink } from "./account-link";
import { LogoLink } from "./logo";
import { MobileMenu } from "./mobile-menu";
import { ServicesMenu } from "./services-menu";

// Public site header. Static on purpose (no server session read): it is part of every prerendered public page.
// The only session-aware bit is <AccountLink> (browser-side check).
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <LogoLink />
        <nav aria-label="Principale" className="hidden items-center gap-6 md:flex">
          <ServicesMenu />
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="text-sm font-medium text-zinc-700 hover:text-brand-800">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-3 md:flex">
          <Link href="/diventa-partner" className="text-sm font-medium text-accent-700 hover:text-accent-800">
            Diventa partner
          </Link>
          <AccountLink className="rounded-md px-3 py-2 text-sm font-medium text-brand-800 hover:bg-brand-50" />
          <Link href="/prenota" className="rounded-md bg-brand-800 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-900">
            Prenota
          </Link>
        </div>
        <MobileMenu />
      </div>
    </header>
  );
}
