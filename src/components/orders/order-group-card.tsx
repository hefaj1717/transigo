import Link from "next/link";
import type { ReactNode } from "react";
import { CHAIN_ROLE_LABEL, type ChainRole } from "@/lib/orders/order-group";
import { formatCents } from "@/lib/pricing/money";

// The orders of a storage chain (D153) on an order page — customer and admin panel: each order with its role, title,
// status and amount, a link to it, and the group total (one payment, one invoice on the first order). Presentational.

export type GroupCardMember = {
  id: string;
  orderNumber: string;
  role: ChainRole | null;
  title: string;
  statusLabel: string;
  totalCents: number | null;
};

export function OrderGroupCard({
  members,
  currentId,
  hrefOf,
  note,
  heading = "Prenotazione collegata",
}: {
  members: GroupCardMember[];
  currentId: string;
  hrefOf: (id: string) => string;
  note?: ReactNode;
  heading?: string;
}) {
  const total = members.every((m) => m.totalCents !== null) ? members.reduce((s, m) => s + (m.totalCents ?? 0), 0) : null;
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm" aria-labelledby="order-group-heading">
      <h2 id="order-group-heading" className="text-lg font-semibold text-zinc-900">{heading}</h2>
      <ol className="mt-3 divide-y divide-zinc-100 text-sm">
        {members.map((m, i) => (
          <li key={m.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {i + 1}. {m.role ? CHAIN_ROLE_LABEL[m.role] : "Ordine"}
              </p>
              {m.id === currentId ? (
                <p className="font-medium text-zinc-900">{m.title} · {m.orderNumber} <span className="text-xs font-normal text-zinc-500">(questo ordine)</span></p>
              ) : (
                <Link href={hrefOf(m.id)} className="font-medium text-blue-700 underline hover:text-blue-900">{m.title} · {m.orderNumber}</Link>
              )}
              <p className="text-xs text-zinc-600">{m.statusLabel}</p>
            </div>
            {m.totalCents !== null ? <p className="whitespace-nowrap text-zinc-900">{formatCents(m.totalCents)}</p> : null}
          </li>
        ))}
      </ol>
      {total !== null ? (
        <p className="mt-2 flex justify-between border-t border-zinc-200 pt-2 text-sm font-semibold text-zinc-900">
          <span>Totale della prenotazione</span>
          <span>{formatCents(total)}</span>
        </p>
      ) : null}
      {note ? <div className="mt-3 text-xs text-zinc-500">{note}</div> : null}
    </section>
  );
}
