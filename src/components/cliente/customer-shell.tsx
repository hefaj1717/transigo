import Link from "next/link";
import type { ReactNode } from "react";
import { LogoLink } from "@/components/site/logo";
import { SignOutButton } from "@/components/sign-out-button";
import { CUSTOMER_STATUS_LABEL, statusTone, type StatusTone } from "@/lib/orders/customer-view";

const AREA_LINKS = [
  { href: "/cliente", label: "I miei ordini" },
  { href: "/cliente/deposito", label: "Deposito" },
  { href: "/cliente/reclami", label: "Reclami" },
  { href: "/cliente/profilo", label: "Profilo" },
] as const;

// Frame of the customer area (spec 7): logo, area links (ordini, deposito, reclami, profilo), "Nuova prenotazione", "Esci".
export function CustomerShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between gap-3 px-4">
          <LogoLink />
          <nav aria-label="Area cliente" className="flex items-center gap-3 sm:gap-4">
            {AREA_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="hidden text-sm font-medium text-zinc-700 hover:text-brand-800 md:inline">{l.label}</Link>
            ))}
            <Link href="/prenota" className="whitespace-nowrap rounded-md bg-brand-800 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-900">
              <span className="sm:hidden">Prenota</span>
              <span className="hidden sm:inline">Nuova prenotazione</span>
            </Link>
            <SignOutButton className="rounded-md py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 sm:px-3" />
          </nav>
        </div>
        {/* Phones and tablets: the area links in a second row (scrolls sideways if needed). */}
        <nav aria-label="Area cliente (mobile)" className="border-t border-zinc-100 md:hidden">
          <div className="mx-auto flex max-w-4xl gap-5 overflow-x-auto px-4 py-2 text-sm font-medium text-zinc-700">
            {AREA_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="whitespace-nowrap hover:text-brand-800">{l.label}</Link>
            ))}
          </div>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <h1 className="text-2xl font-bold tracking-tight text-brand-900 sm:text-3xl">{title}</h1>
        {subtitle ? <div className="mt-1 text-sm text-zinc-600">{subtitle}</div> : null}
        <div className="mt-6 text-zinc-700">{children}</div>
      </main>
    </div>
  );
}

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "bg-zinc-100 text-zinc-700",
  info: "bg-brand-50 text-brand-800",
  progress: "bg-brand-100 text-brand-900",
  success: "bg-accent-100 text-accent-800",
  warning: "bg-amber-100 text-amber-900",
  muted: "bg-zinc-100 text-zinc-500",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[statusTone(status)]}`}>{CUSTOMER_STATUS_LABEL[status] ?? status}</span>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-zinc-200 bg-white p-5 ${className}`}>{children}</section>;
}
