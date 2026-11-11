"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SERVICES } from "@/lib/public/content";

/** Desktop "Servizi" dropdown (D158). Closes on navigation, Escape and a click outside. */
export function ServicesMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = SERVICES.some((s) => pathname === s.href);
  return (
    <div
      ref={root}
      className="relative"
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="services-menu"
        className={`flex items-center gap-1 text-sm font-medium hover:text-brand-800 ${active ? "text-brand-800" : "text-zinc-700"}`}
      >
        Servizi
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <ul id="services-menu" className="absolute left-0 top-full z-40 mt-3 w-80 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg">
          {SERVICES.map((s) => (
            <li key={s.code}>
              <Link href={s.href} aria-current={pathname === s.href ? "page" : undefined} className="block rounded-lg px-3 py-2.5 hover:bg-brand-50">
                <span className="block text-sm font-semibold text-brand-900">{s.title}</span>
                <span className="mt-0.5 block text-xs text-zinc-600 line-clamp-2">{s.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
