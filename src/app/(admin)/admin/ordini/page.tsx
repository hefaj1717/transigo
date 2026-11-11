import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { AdminShell } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { ADMIN_ORDER_PATHS, HANDOVER_BADGE, handoverKind, isHandoverPending, ORDER_FILTERS, teamTooSmall } from "@/lib/orders/dispatch";
import { orderStatusLabel, PAYMENT_STATE_LABEL, paymentState } from "@/lib/orders/status";
import { dispatchable, SERVICE_FILTERS, SERVICE_TYPE_LABEL, serviceFilter, serviceTypeOf } from "@/lib/orders/service-type";
import { formatCents } from "@/lib/pricing/money";
import { stripeDashboardPaymentUrl } from "@/lib/stripe/keys";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Ordini – Transigo" };

// Admin order list: order and payment status, carrier, link to the payment in the Stripe Dashboard and to the
// order page (assignment and status changes, D122). Filters by status and by service type (D151; ?filtro= and
// ?servizio= combine). Storage orders are never dispatched to carriers, so "Da assegnare" leaves them out.
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
  service_type: string;
  status: string;
  created_at: string;
  pickup_window_start: string;
  payment_due_at: string;
  paid_at: string | null;
  order_charges: { total_cents: number; refunded_cents: number } | null;
  customers: { profiles: { first_name: string | null; last_name: string | null; email: string } | null } | null;
  payments: { status: string; stripe_payment_intent_id: string | null; review_reason: string | null; created_at: string }[];
  carriers: { company_name: string; offers_porters: boolean; porters_team_size: number | null } | null;
  order_porter_jobs: { persons: number } | null;
};

const FILTERS = ORDER_FILTERS;

const REVIEW_REASON: Record<string, string> = {
  amount_mismatch: "importo diverso",
  currency_mismatch: "valuta diversa",
  duplicate_payment: "pagamento doppio",
  late_payment: "pagato dopo la scadenza",
};

const rome = (iso: string) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" });
// Storage orders start at midnight in Rome of their first day: the date only.
const romeDay = (iso: string) => new Date(iso).toLocaleDateString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short" });

async function Content({ searchParams }: Pick<PageProps<"/admin/ordini">, "searchParams">) {
  await requireArea("admin", "/admin/ordini");
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.filtro) ?? FILTERS[0];
  const service = serviceFilter(sp.servizio);
  const href = (filtro: string, servizio: string) => {
    const params = new URLSearchParams();
    if (filtro !== "tutti") params.set("filtro", filtro);
    if (servizio !== "tutti") params.set("servizio", servizio);
    const qs = params.toString();
    return qs ? `/admin/ordini?${qs}` : "/admin/ordini";
  };

  // Admin's own client: RLS gives admins read access to every order and payment.
  const db = await createClient();
  let q = db
    .from("orders")
    .select(
      "id, order_number, service_type, status, created_at, pickup_window_start, payment_due_at, paid_at, handover_required_at, handover_leg_index, carrier_id, order_charges(total_cents, refunded_cents), customers(profiles(first_name, last_name, email)), payments(status, stripe_payment_intent_id, review_reason, created_at), carriers(company_name, offers_porters, porters_team_size), order_porter_jobs(persons)",
    )
    .order(filter.unassigned ? "pickup_window_start" : "created_at", { ascending: !!filter.unassigned })
    .limit(100);
  if (filter.statuses) q = q.in("status", filter.statuses);
  if (filter.unassigned) q = q.is("carrier_id", null).neq("service_type", "storage");
  if (service.type) q = q.eq("service_type", service.type);
  if (filter.handover) q = q.not("handover_required_at", "is", null);
  if (filter.byIds) q = q.in("id", await orderIdsFor(db, filter.byIds));
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
      <nav aria-label="Stato" className="mb-2 flex flex-wrap gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link key={f.key} href={href(f.key, service.key)} className={`rounded-full px-3 py-1 ${f.key === filter.key ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"}`}>
            {f.label}
          </Link>
        ))}
      </nav>
      <nav aria-label="Servizio" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-500">Servizio:</span>
        {SERVICE_FILTERS.map((f) => (
          <Link key={f.key} href={href(filter.key, f.key)} aria-current={f.key === service.key ? "page" : undefined} className={`rounded-full border px-3 py-0.5 ${f.key === service.key ? "border-blue-600 bg-blue-50 text-blue-800" : "border-zinc-200 text-zinc-700 hover:bg-zinc-50"}`}>
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
              <th className="py-2 pr-3 font-medium">Data</th>
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
              const type = serviceTypeOf(o.service_type);
              return (
                <tr key={o.id} className="border-t border-zinc-100 align-top">
                  <td className="py-2 pr-3 font-medium text-zinc-900">
                    <Link href={ADMIN_ORDER_PATHS.detail(o.id)} className="text-blue-700 hover:underline">{o.order_number}</Link>
                    <div className="text-xs font-normal text-zinc-500">{rome(o.created_at)}</div>
                    <span className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-xs font-normal ${type === "transport" ? "bg-zinc-100 text-zinc-700" : "bg-violet-100 text-violet-900"}`}>{SERVICE_TYPE_LABEL[type]}</span>
                  </td>
                  <td className="py-2 pr-3">
                    {[p?.first_name, p?.last_name].filter(Boolean).join(" ") || "—"}
                    <div className="text-xs text-zinc-500">{p?.email}</div>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{type === "storage" ? `dal ${romeDay(o.pickup_window_start)}` : rome(o.pickup_window_start)}</td>
                  <td className="py-2 pr-3">
                    {orderStatusLabel(o.status, o.service_type)}
                    {teamTooSmall(o, o.order_porter_jobs?.persons, o.carriers) ? <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-900">Squadra insufficiente</span> : null}
                  </td>
                  <td className="py-2 pr-3">
                    {isHandoverPending(o) ? (
                      <Link href={ADMIN_ORDER_PATHS.detail(o.id)} className="inline-block rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900 underline">{HANDOVER_BADGE[handoverKind(o, (handoverSteps ?? []).filter((x) => x.order_id === o.id))]}</Link>
                    ) : o.carriers?.company_name ?? (o.status === "paid" && dispatchable(type) ? <Link href={ADMIN_ORDER_PATHS.detail(o.id)} className="text-amber-800 underline">Da assegnare</Link> : <span className="text-zinc-400">—</span>)}
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

/** Orders with a payment still to check (D96, D141) or a refund to complete (D142: pending, or failed and not retried). */
async function orderIdsFor(db: Awaited<ReturnType<typeof createClient>>, kind: "payment_review" | "refunds"): Promise<string[]> {
  if (kind === "payment_review") {
    const { data, error } = await db.from("payments").select("order_id").eq("status", "succeeded").not("review_reason", "is", null).is("reviewed_at", null);
    if (error) throw new Error(`payments unavailable: ${error.code}`);
    return [...new Set(data.map((p) => p.order_id as string))];
  }
  const { data, error } = await db.from("refunds").select("id, order_id, status, retry_of").neq("status", "succeeded");
  if (error) throw new Error(`refunds unavailable: ${error.code}`);
  const retried = new Set(data.map((r) => r.retry_of).filter(Boolean));
  return [...new Set(data.filter((r) => r.status === "pending" || !retried.has(r.id)).map((r) => r.order_id as string))];
}
