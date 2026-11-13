"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import { BOOKING_TABS, type BookingService } from "@/lib/public/booking-tabs";

export type { BookingService };

// Service switcher above the three booking wizards (D151: Trasporto, Facchinaggio and Deposito are peers).
// With `onSelect` (BookingHub) a click switches the wizard in place, without a page load; the links stay real
// links, so a new tab / middle click / no-JS still open the other wizard's page.
// The white "pill" behind the active tab is one element that slides to the chosen tab (measured after layout).
export function BookingServiceTabs({ active, onSelect }: { active: BookingService; onSelect?: (key: BookingService) => void }) {
  const nav = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!el) return;
    const measure = () => setPill({ left: el.offsetLeft, width: el.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav.current!);
    return () => ro.disconnect();
  }, [active]);

  return (
    <nav ref={nav} aria-label="Scegli il servizio" className="relative mb-6 flex gap-1 rounded-lg bg-zinc-100 p-1 sm:inline-flex">
      {/* Before the first measurement (server HTML) the active tab paints its own background instead. */}
      {pill ? (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 rounded-md bg-white shadow-sm transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{ width: pill.width, transform: `translateX(${pill.left}px)` }}
        />
      ) : null}
      {BOOKING_TABS.map((t) => (
        <Link
          key={t.key}
          data-tab={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          onClick={(e) => {
            if (!onSelect || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onSelect(t.key);
          }}
          className={
            "relative flex-1 rounded-md px-4 py-2 text-center text-sm font-semibold transition-colors duration-300 sm:flex-none " +
            (t.key === active ? "text-brand-800 " + (pill ? "" : "bg-white shadow-sm") : "text-zinc-600 hover:text-zinc-900")
          }
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
