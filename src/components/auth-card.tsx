import type { ReactNode } from "react";

/** Simple centered card for account pages. Styling is intentionally basic (design comes later). */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex flex-1 items-start justify-center px-4 py-12">
      <div className="w-full max-w-lg rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-zinc-900">{title}</h1>
        {subtitle ? <div className="mt-1 text-sm text-zinc-600">{subtitle}</div> : null}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
