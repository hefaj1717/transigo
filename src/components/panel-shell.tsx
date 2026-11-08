import type { ReactNode } from "react";
import { SignOutButton } from "./sign-out-button";

/** Minimal panel page: greeting + sign-out. Real navigation comes with each panel's features. */
export function PanelShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-zinc-900">{title}</h1>
        <SignOutButton />
      </div>
      <div className="mt-6 text-zinc-700">{children}</div>
    </main>
  );
}

export function Loading() {
  return <p className="px-4 py-10 text-center text-sm text-zinc-500">Caricamento…</p>;
}
