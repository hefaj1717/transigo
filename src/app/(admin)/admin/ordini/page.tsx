import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { AdminShell } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { ADMIN_ORDER_PATHS, HANDOVER_BADGE, handoverKind, isHandoverPending, ORDER_FILTERS } from "@/lib/orders/dispatch";
import { ORDER_STATUS_LABEL, PAYMENT_STATE_LABEL, paymentState } from "@/lib/orders/status";
import { formatCents } from "@/lib/pricing/money";
import { stripeDashboardPaymentUrl } from "@/lib/stripe/keys";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Ordini – Transigo" };

// Admin order list: order and payment status, carrier, link to the payment in the Stripe Dashboard and to the
// order page (assignment and status changes, D122). Actions on payments under review come in Stage 6.
export default function Page({ searchParams }: PageProps<"/admin/ordini">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

type Row = {
  id: string;
  handover_required_at: string | null;
  handover_leg_index: number | null;
  carrier_id: string | null;
  order_number: string;
  status: string;
  created_at: string;
  pickup_window_start: string;
  payment_due_at: string;
  paid_at: string | null;
  order_charges: { total_cents: number; refunded_cents: number } | null;
  customers: { profiles: { first_name: string | null; last_name: string | null; email: string } | null } | null;
  payments: { status: string; stripe_payment_intent_id: string | null; review_reason: string | null; created_at: string }[];
  carriers: { company_name: string } | null;
};

const FILTERS = ORDER_FILTERS;

const REVIEW_REASON: Record<string, string> = {
  amount_mismatch: "importo diverso",
  currency_mismatch: "valuta diversa",
  duplicate_payment: "pagamento doppio",
  late_payment: "pagato dopo la scadenza",
};

const rome = (iso: string) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" });

async function Content({ searchParams }: Pick<PageProps<"/admin/ordini">, "searchParams">) {
  await requireArea("admin", "/admin/ordini");
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.filtro) ?? FILTERS[0];

  // Admin's own client: RLS gives admins read access to every order and payment.
  const db = await createClient();
  let q = db
    .from("orders")
    .select(
      "id, order_number, status, created_at, pickup_window_start, payment_due_at, paid_at, handover_required_at, handover_leg_index, carrier_id, order_charges(total_cents, refunded_cents), customers(profiles(first_name, last_name, email)), payments(status, stripe_payment_intent_id, review_reason, created_at), carriers(company_name)",
    )
    .order(filter.unassigned ? "pickup_window_start" : "created_at", { ascending: !!filter.unassigned })
    .limit(100);
  if (filter.statuses) q = q.in("status", filter.statuses);
  if (filter.unassigned) q = q.is("carrier_id", null);
  if (filter.handover) q = q.not("handover_required_at", "is", null);
  const { data: orders, error } = await q.returns<Row[]>();
  const now = new Date();
  // "Da gestire" badge: on board or in the warehouse (D136) — from the steps of those orders only
  const handoverIds = (orders ?? []).filter(isHandoverPending).map((o) => o.id);
  const { data: handoverSteps } = handoverIds.length
    ? await db.from("order_leg_steps").select("order_id, leg_index, step, reverted_at").in("order_id", handoverIds)
        .returns<{ order_id: string; leg_index: number; step: string; reverted_at: string | null }[]>()
    : { data: [] };

  return (
    <AdminShell title="Ordini">
      <nav className="mb-4 flex flex-wrap gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link key={f.key} href={f.key === "tutti" ? "/admin/ordini" : `/admin/ordini?filtro=${f.key}`} className={`rounded-full px-3 py-1 ${f.key === filter.key ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"}`}>
            {f.label}
          </Link>
        ))}
      </nav>
      {error ? <p className="text-sm text-red-700">Errore nel caricamento degli ordini.</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-2 pr-3 font-medium">Ordine</th>
              <th className="py-2 pr-3 font-medium">Cliente</th>
              <th className="py-2 pr-3 font-medium">Ritiro</th>
              <th className="py-2 pr-3 font-medium">Stato</th>
              <th className="py-2 pr-3 font-medium">Padroncino</th>
              <th className="py-2 pr-3 font-medium">Pagamento</th>
              <th className="py-2 pr-3 text-right font-medium">Totale</th>
              <th className="py-2 font-medium">Stripe</th>
            </tr>
          </thead>
          <tbody>
            {(orders ?? []).map((o) => {
              const p = o.customers?.profiles;
              const pay = paymentState({ ...o, refunded_cents: o.order_charges?.refunded_cents, total_cents: o.order_charges?.total_cents }, now);
              const payments = [...o.payments].sort((a, b) => b.created_at.localeCompare(a.created_at));
              const succeeded = payments.filter((x) => x.status === "succeeded" && x.stripe_payment_intent_id);
              const reviews = succeeded.filter((x) => x.review_reason);
              return (
                <tr key={o.id} className="border-t border-zinc-100 align-top">
                  <td className="py-2 pr-3 font-medium text-zinc-900">
                    <Link href={ADMIN_ORDER_PATHS.detail(o.id)} className="text-blue-700 hover:underline">{o.order_number}</Link>
                    <div className="text-xs font-normal text-zinc-500">{rome(o.created_at)}</div>
                  </td>
                  <td className="py-2 pr-3">
                    {[p?.first_name, p?.last_name].filter(Boolean).join(" ") || "—"}
                    <div className="text-xs text-zinc-500">{p?.email}</div>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{rome(o.pickup_window_start)}</td>
                  <td className="py-2 pr-3">{ORDER_STATUS_LABEL[o.status] ?? o.status}</td>
                  <td className="py-2 pr-3">
                    {isHandoverPending(o) ? (
                      <Link href={ADMIN_ORDER_PATHS.detail(o.id)} className="inline-block rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900 underline">{HANDOVER_BADGE[handoverKind(o, (handoverSteps ?? []).filter((x) => x.order_id === o.id))]}</Link>
                    ) : o.carriers?.company_name ?? (o.status === "paid" ? <Link href={ADMIN_ORDER_PATHS.detail(o.id)} className="text-amber-800 underline">Da assegnare</Link> : <span className="text-zinc-400">—</span>)}
                  </td>
                  <td className="py-2 pr-3">
                    {PAYMENT_STATE_LABEL[pay]}
                    {pay === "to_pay" ? <div className="text-xs text-zinc-500">entro {rome(o.payment_due_at)}</div> : null}
                    {reviews.map((r) => (
                      <div key={r.stripe_payment_intent_id} className="text-xs text-amber-800">Da verificare: {REVIEW_REASON[r.review_reason ?? ""] ?? r.review_reason}</div>
                    ))}
                  </td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap">{o.order_charges ? formatCents(o.order_charges.total_cents) : "—"}</td>
                  <td className="py-2">
                    {succeeded.length
                      ? succeeded.map((x) => (
                          <a key={x.stripe_payment_intent_id} href={stripeDashboardPaymentUrl(x.stripe_payment_intent_id!)} target="_blank" rel="noopener noreferrer" className="block text-blue-700 underline">
                            Apri in Stripe
                          </a>
                        ))
                      : <span className="text-zinc-400">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {orders && !orders.length ? <p className="mt-4 text-sm text-zinc-600">Nessun ordine.</p> : null}
    </AdminShell>
  );
}
