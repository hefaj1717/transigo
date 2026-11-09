import type { ReactNode } from "react";

/** Navy (or green, for the carrier side) title band of the public pages. */
export function PageHero({ title, lead, tone = "brand", children }: { title: string; lead: string; tone?: "brand" | "accent"; children?: ReactNode }) {
  const bg = tone === "accent" ? "bg-accent-700" : "bg-brand-900";
  const text = tone === "accent" ? "text-accent-50" : "text-brand-100";
  return (
    <section className={`${bg} text-white`}>
      <div className="mx-auto max-w-6xl px-4 py-14">
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">{title}</h1>
        <p className={`mt-5 max-w-2xl text-lg ${text}`}>{lead}</p>
        {children ? <div className="mt-8">{children}</div> : null}
      </div>
    </section>
  );
}

/** Numbered steps (navy for customers, green for carriers). */
export function Steps({ steps, tone = "brand" }: { steps: { title: string; text: string }[]; tone?: "brand" | "accent" }) {
  const dot = tone === "accent" ? "bg-accent-600" : "bg-brand-800";
  return (
    <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {steps.map((s, i) => (
        <li key={s.title} className="rounded-xl border border-zinc-200 bg-white p-6">
          <span className={`flex h-10 w-10 items-center justify-center rounded-full ${dot} text-lg font-bold text-white`}>{i + 1}</span>
          <h3 className="mt-4 text-lg font-semibold text-brand-900">{s.title}</h3>
          <p className="mt-2 text-sm text-zinc-600">{s.text}</p>
        </li>
      ))}
    </ol>
  );
}
