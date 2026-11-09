"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { NAV_LINKS } from "@/lib/public/content";

/** Phone menu (below md). Closes on navigation. */
export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  const item = "block rounded-md px-3 py-3 text-base font-medium text-zinc-800 hover:bg-brand-50";
  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="mobile-menu"
        aria-label={open ? "Chiudi menu" : "Apri menu"}
        className="rounded-md p-2 text-brand-800 hover:bg-brand-50"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>
      {open ? (
        <nav id="mobile-menu" aria-label="Principale" className="absolute inset-x-0 top-16 border-b border-zinc-200 bg-white px-4 pb-4 shadow-lg">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={item}>
              {l.label}
            </Link>
          ))}
          <Link href="/diventa-partner" className={`${item} text-accent-700`}>
            Diventa partner
          </Link>
          <Link href="/accedi" className={item}>
            Accedi
          </Link>
          <Link href="/prenota" className="mt-2 block rounded-md bg-brand-800 px-3 py-3 text-center text-base font-semibold text-white hover:bg-brand-900">
            Prenota
          </Link>
        </nav>
      ) : null}
    </div>
  );
}
