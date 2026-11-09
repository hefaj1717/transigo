"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { JOB_PATHS } from "@/lib/carriers/jobs";
import { CARRIER_PATHS } from "@/lib/carriers/onboarding";

// Bottom navigation of the carrier app: Corse / Le mie corse / Profilo. Fixed to the bottom with room for the
// home indicator (safe-area-inset-bottom); CarrierShell reserves the same height under the content
// (BOTTOM_NAV_SPACE) so nothing — not even the sticky "Accetta la Corsa" bar — ends up under it.

type Item = { href: string; label: string; match: (p: string) => boolean; icon: React.ReactNode };

const svg = (d: string) => (
  <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const ITEMS: Item[] = [
  {
    href: JOB_PATHS.available,
    label: "Corse",
    match: (p) => p === JOB_PATHS.available || p.startsWith(`${JOB_PATHS.available}/`),
    icon: svg("M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"),
  },
  {
    href: JOB_PATHS.mine,
    label: "Le mie corse",
    match: (p) => p === JOB_PATHS.mine || p.startsWith(`${JOB_PATHS.mine}/`),
    icon: svg("M9 5h10M9 12h10M9 19h10M4 5h.01M4 12h.01M4 19h.01"),
  },
  {
    href: CARRIER_PATHS.home,
    label: "Profilo",
    match: (p) => !p.startsWith(JOB_PATHS.available) && !p.startsWith(JOB_PATHS.mine),
    icon: svg("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0"),
  },
];

export function BottomNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Navigazione principale" className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)]">
      <ul className="mx-auto grid h-16 w-full max-w-md grid-cols-3">
        {ITEMS.map((item) => {
          const active = item.match(pathname);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-full min-h-11 flex-col items-center justify-center gap-0.5 text-xs font-medium ${
                  active ? "text-[#0B3B8C]" : "text-zinc-500 active:text-zinc-800"
                }`}
              >
                {item.icon}
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
