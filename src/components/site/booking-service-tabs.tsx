"use client";

import Link from "next/link";
import { BOOKING_TABS, type BookingService } from "@/lib/public/booking-tabs";

export type { BookingService };

// Service switcher above the three booking wizards (D151: Trasporto, Facchinaggio and Deposito are peers).
// With `onSelect` (BookingHub) a click switches the wizard in place, without a page load; the links stay real
// links, so a new tab / middle click / no-JS still open the other wizard's page.
export function BookingServiceTabs({ active, onSelect }: { active: BookingService; onSelect?: (key: BookingService) => void }) {
  return (
    <nav aria-label="Scegli il servizio" className="mb-6 flex gap-1 rounded-lg bg-zinc-100 p-1 sm:inline-flex">
      {BOOKING_TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          onClick={(e) => {
            if (!onSelect || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onSelect(t.key);
          }}
          className={
            "flex-1 rounded-md px-4 py-2 text-center text-sm font-semibold sm:flex-none " +
            (t.key === active ? "bg-white text-brand-800 shadow-sm" : "text-zinc-600 hover:text-zinc-900")
          }
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
