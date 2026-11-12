import { Suspense } from "react";
import Link from "next/link";
import { Card, CustomerShell, StatusBadge } from "@/components/cliente/customer-shell";
import { Loading } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";
import { customerListEntries, orderTitle } from "@/lib/orders/customer-view";
import { CHAIN_ROLE_LABEL } from "@/lib/orders/order-group";
import { formatDateOnly, serviceTypeOf } from "@/lib/orders/service-type";
import { PAYMENT_STATE_LABEL, paymentState } from "@/lib/orders/status";
import { formatCents } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import { PayNowButton } from "./ordini/order-actions";
import { ResumeBooking } from "./resume-booking";

export const metadata = { title: "I miei ordini – Transigo" };

// Customer area home (spec 7): orders "In corso" / "Conclusi" as cards. Read with the customer's own
// session: RLS returns only their orders and never carrier amounts (D29, D77).
export default function Page({ searchParams }: PageProps<"/cliente">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

type OrderRow = {
  id: string;
  order_number: string;
  service_type: string;
  parent_order_id: string | null;
  status: string;
  pickup_window_start: string;
  created_at: string;
  payment_due_at: string;
  paid_at: string | null;
  order_charges: { total_cents: number; refunded_cents: number } | null;
  order_legs: { leg_index: number; pickup_city: string; delivery_city: string; pickup_window_end: string }[];
  // Facchinaggio / Deposito (D151): no legs — the job or the booking instead
  order_porter_jobs: { city: string; window_end: string } | null;
  warehouse_bookings: { unit: string; box_code: string | null; pallets: number | null; start_date: string; end_date: string } | null;
};

const TABS = [
  { key: "in-corso", label: "In corso", group: "active" },
  { key: "conclusi", label: "Conclusi", group: "finished" },
] as const;

const rome = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", ...opts });

async function Content({ searchParams }: Pick<PageProps<"/cliente">, "searchParams">) {
  const ctx = await requireArea("cliente", "/cliente");
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, order_number, service_type, parent_order_id, status, pickup_window_start, created_at, payment_due_at, paid_at, order_charges(total_cents, refunded_cents), order_legs(leg_index, pickup_city, delivery_city, pickup_window_end), order_porter_jobs(city, window_end), warehouse_bookings(unit, box_code, pallets, start_date, end_date)")
    .order("pickup_window_start", { ascending: false })
    .limit(200)
    .returns<OrderRow[]>();

  // A storage chain (D153) is one card: one booking, one payment on its first order.
  const all = customerListEntries(orders ?? []).sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const counts = { active: all.filter((e) => e.tab === "active").length, finished: all.filter((e) => e.tab === "finished").length };
  // Default tab: "In corso", unless there is nothing in progress but there are finished orders.
  const tab = TABS.find((t) => t.key === sp.stato) ?? (counts.active === 0 && counts.finished > 0 ? TABS[1] : TABS[0]);
  const shown = all.filter((e) => e.tab === tab.group);
  // In progress: soonest pickup first.
  if (tab.group === "active") shown.reverse();
  const now = new Date();

  return (
    <CustomerShell title={`Ciao${ctx.firstName ? `, ${ctx.firstName}` : ""}!`} subtitle="Qui trovi le tue prenotazioni e il loro stato.">
      <ResumeBooking />
      <nav aria-label="Filtra ordini" className="mb-5 flex gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "in-corso" ? "/cliente?stato=in-corso" : "/cliente?stato=conclusi"}
            aria-current={t.key === tab.key ? "page" : undefined}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${t.key === tab.key ? "bg-brand-800 text-white" : "bg-white text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-100"}`}
          >
            {t.label} <span className="opacity-70">({counts[t.group]})</span>
          </Link>
        ))}
      </nav>

      {error ? <p className="text-sm text-red-700">Non è stato possibile caricare gli ordini. Riprova tra poco.</p> : null}

      {!error && !shown.length ? (
        <Card>
          <p className="text-zinc-600">{tab.group === "active" ? "Non hai prenotazioni in corso." : "Non hai ancora ordini conclusi."}</p>
          <Link href="/prenota" className="mt-4 inline-block rounded-md bg-accent-600 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-700">Calcola il prezzo</Link>
        </Card>
      ) : null}

      <ul className="space-y-3">
        {shown.map((entry) => {
          const o = entry.root;
          const chain = entry.members.length > 1 ? entry.members : null;
          const storage = entry.members.find((m) => serviceTypeOf(m.service_type) === "storage");
          const pay = paymentState({ ...o, refunded_cents: entry.refundedCents, total_cents: entry.totalCents }, now);
          const firstLeg = [...o.order_legs].sort((a, b) => a.leg_index - b.leg_index)[0];
          const type = serviceTypeOf(o.service_type);
          const windowEnd = firstLeg?.pickup_window_end ?? o.order_porter_jobs?.window_end;
          return (
            <li key={o.id}>
              <Card className="transition hover:border-brand-300 hover:shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/cliente/ordini/${o.id}`} className="text-lg font-semibold text-brand-900 hover:underline">
                      {chain && storage ? `${orderTitle(storage)} con trasporto` : orderTitle(o)}
                    </Link>
                    <p className="mt-1 text-sm text-zinc-600">
                      {chain && storage?.warehouse_bookings ? (
                        <>Dal {formatDateOnly(storage.warehouse_bookings.start_date)} al {formatDateOnly(storage.warehouse_bookings.end_date)}</>
                      ) : type === "storage" && o.warehouse_bookings ? (
                        <>Dal {formatDateOnly(o.warehouse_bookings.start_date)} al {formatDateOnly(o.warehouse_bookings.end_date)}</>
                      ) : (
                        <>
                          {type === "porters" ? "Facchini" : "Ritiro"} {rome(o.pickup_window_start, { weekday: "short", day: "numeric", month: "short" })}, {rome(o.pickup_window_start, { hour: "2-digit", minute: "2-digit" })}
                          {windowEnd ? `–${rome(windowEnd, { hour: "2-digit", minute: "2-digit" })}` : ""}
                        </>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">{chain ? `Ordini ${chain.map((m) => m.order_number).join(" → ")}` : `Ordine ${o.order_number}`}</p>
                  </div>
                  <div className="text-right">
                    {chain ? null : <StatusBadge status={o.status} serviceType={o.service_type} />}
                    <p className="mt-2 font-semibold text-zinc-900">{entry.totalCents !== null ? formatCents(entry.totalCents) : "—"}</p>
                    {pay !== "paid" ? <p className="text-xs text-zinc-500">{PAYMENT_STATE_LABEL[pay]}</p> : null}
                  </div>
                </div>
                {chain ? (
                  <ul className="mt-3 divide-y divide-zinc-100 rounded-md border border-zinc-100 text-sm">
                    {chain.map((m) => (
                      <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <span className="text-zinc-700">{m.role ? CHAIN_ROLE_LABEL[m.role] : orderTitle(m)}</span>
                        <StatusBadge status={m.status} serviceType={m.service_type} />
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Link href={`/cliente/ordini/${o.id}`} className="text-sm font-medium text-brand-700 hover:text-brand-900">Dettagli →</Link>
                  {pay === "to_pay" ? <PayNowButton orderId={o.id} compact /> : null}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </CustomerShell>
  );
}
