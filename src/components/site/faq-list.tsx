import type { Faq } from "@/lib/public/content";

/** FAQ accordion without JavaScript (<details>). */
export function FaqList({ faqs }: { faqs: Pick<Faq, "q" | "a">[] }) {
  return (
    <div className="divide-y divide-zinc-200 rounded-xl border border-zinc-200">
      {faqs.map((f) => (
        <details key={f.q} className="group p-5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-brand-900">
            {f.q}
            <span className="text-brand-500 transition group-open:rotate-45" aria-hidden="true">+</span>
          </summary>
          <p className="mt-3 text-sm text-zinc-600">{f.a}</p>
        </details>
      ))}
    </div>
  );
}
