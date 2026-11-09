import type { ReactNode } from "react";
import { SignOutButton } from "@/components/sign-out-button";

// Mobile-first frame of the carrier app (D104): sticky top bar in the brand colour, one narrow column,
// room for the phone's safe areas (notch, home indicator). The bottom navigation comes with the
// onboarding / jobs sections (Stage 4).
export function CarrierShell({ title, children }: { title: string; children: ReactNode }) {
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
      <main className="mx-auto w-full max-w-md flex-1 px-4 pt-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <h1 className="text-2xl font-semibold text-zinc-900">{title}</h1>
        <div className="mt-4 text-zinc-700">{children}</div>
      </main>
    </div>
  );
}

/** Large tap targets for the carrier app (min. 48 px high, full width). */
export const bigButton =
  "flex min-h-12 w-full items-center justify-center rounded-xl bg-[#0B3B8C] px-5 text-base font-semibold text-white active:bg-[#082c69] disabled:opacity-60";
export const bigButtonSecondary =
  "flex min-h-12 w-full items-center justify-center rounded-xl border border-zinc-300 bg-white px-5 text-base font-semibold text-zinc-900 active:bg-zinc-100 disabled:opacity-60";
