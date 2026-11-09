import type { ReactNode } from "react";
import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { BottomNav } from "./bottom-nav";

// Mobile-first frame of the carrier app (D104): sticky top bar in the brand colour, one narrow column (works
// from 360 px), bottom navigation (Corse / Le mie corse / Profilo) and room for the phone's safe areas
// (notch, home indicator). The main column reserves the bottom navigation's height + the safe area, so the
// last element (and a sticky action bar, see stickyActionBar) is never hidden under the navigation.
export function CarrierShell({ title, children, back }: { title: string; children: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-zinc-50">
      <header className="sticky top-0 z-10 bg-[#0B3B8C] pt-[env(safe-area-inset-top)] text-white shadow">
        <div className="mx-auto flex h-14 w-full max-w-md items-center justify-between gap-3 px-4">
          <span className="flex items-center gap-2 font-semibold">
            <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-white text-lg font-bold text-[#0B3B8C]">T</span>
            Transigo Partner
          </span>
          <SignOutButton className="min-h-11 rounded-lg px-3 text-sm font-medium text-white/90 hover:bg-white/10" />
        </div>
      </header>
      <main className="mx-auto w-full min-w-0 max-w-md flex-1 px-4 pt-5 pb-[calc(5.5rem+env(safe-area-inset-bottom))]">
        {back ? (
          <Link href={back.href} className="-ml-1 mb-2 inline-flex min-h-11 items-center gap-1 px-1 text-sm font-medium text-[#0B3B8C]">
            <span aria-hidden>←</span> {back.label}
          </Link>
        ) : null}
        <h1 className="text-2xl font-semibold break-words text-zinc-900">{title}</h1>
        <div className="mt-4 text-zinc-700">{children}</div>
      </main>
      <BottomNav />
    </div>
  );
}

/** Large tap targets for the carrier app (min. 48 px high, full width). */
export const bigButton =
  "flex min-h-12 w-full items-center justify-center rounded-xl bg-[#0B3B8C] px-5 text-base font-semibold text-white active:bg-[#082c69] disabled:opacity-60";
export const bigButtonSecondary =
  "flex min-h-12 w-full items-center justify-center rounded-xl border border-zinc-300 bg-white px-5 text-base font-semibold text-zinc-900 active:bg-zinc-100 disabled:opacity-60";

/**
 * Main action kept within thumb reach: sticks to the bottom of the screen just above the bottom navigation
 * (4 rem + safe area) while scrolling, and sits in the normal flow at the end of the page — so it never covers
 * the content. Use as the LAST child of the page content.
 */
export const stickyActionBar =
  "sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 -mx-1 mt-6 rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-lg backdrop-blur";
