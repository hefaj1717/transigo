import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "@/components/sign-out-button";

const LINKS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/ordini", label: "Ordini" },
  { href: "/admin/padroncini", label: "Padroncini" },
  { href: "/admin/richieste", label: "Richieste" },
  { href: "/admin/email", label: "E-mail" },
  { href: "/admin/listini", label: "Listini" },
  { href: "/admin/veicoli", label: "Veicoli" },
  { href: "/admin/area-di-servizio", label: "Area di servizio" },
  { href: "/admin/festivita", label: "Festività" },
  { href: "/admin/magazzino", label: "Magazzino" },
];

export function AdminNav() {
  return (
    <nav className="mb-6 flex flex-wrap gap-x-4 gap-y-1 border-b border-zinc-200 pb-3 text-sm">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="text-blue-700 hover:underline">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

export const inputClass = "rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-900";

/** Wider panel layout for admin screens (tables). */
export function AdminShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-zinc-900">{title}</h1>
        <SignOutButton />
      </div>
      <AdminNav />
      <div className="text-zinc-700">{children}</div>
    </main>
  );
}
