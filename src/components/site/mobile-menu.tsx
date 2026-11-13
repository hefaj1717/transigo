"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NAV_LINKS, SERVICES } from "@/lib/public/content";

/**
 * Phone menu (below md): a side panel that slides in from the right over a dimmed page. Closes on navigation,
 * Escape and a tap on the backdrop. Always mounted so it can animate; while closed it is `inert` (no focus,
 * hidden from screen readers). Positioned `absolute`, not `fixed`: the header's backdrop-blur makes it the
 * containing block of fixed children anyway.
 */
export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    // The page behind the panel must not scroll under the finger.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "block rounded-md px-3 py-3 text-base font-medium text-zinc-800 hover:bg-brand-50";
  return (
    <div className="md:hidden">
      <button
        ref={button}
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
      {/* Clips the panel while it sits off-screen: no horizontal page scroll on phones. */}
      <div className={`absolute inset-x-0 top-16 h-[calc(100dvh-4rem)] overflow-hidden ${open ? "" : "pointer-events-none"}`}>
        <div
          aria-hidden="true"
          onClick={() => setOpen(false)}
          className={`absolute inset-0 bg-zinc-900/30 transition-opacity duration-300 motion-reduce:transition-none ${open ? "opacity-100" : "opacity-0"}`}
        />
        <nav
          id="mobile-menu"
          aria-label="Principale"
          inert={!open}
          className={`absolute inset-y-0 right-0 w-80 max-w-[85vw] overflow-y-auto overscroll-contain border-l border-zinc-200 bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl transition-transform duration-300 ease-out motion-reduce:transition-none ${open ? "translate-x-0" : "translate-x-full"}`}
        >
          <p className="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Servizi</p>
          <ul className="border-b border-zinc-100 pb-2">
            {SERVICES.map((s) => (
              <li key={s.code}>
                <Link href={s.href} className={`${item} pl-6`}>
                  {s.title}
                </Link>
              </li>
            ))}
          </ul>
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
      </div>
    </div>
  );
}
