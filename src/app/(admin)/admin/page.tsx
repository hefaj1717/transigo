import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { Loading } from "@/components/panel-shell";
import { AdminShell } from "@/components/admin/admin-nav";
import { expiringDocuments, monthFinance, romeMonthRange, unassignedTooLong, type DocLike, type FinanceOrder } from "@/lib/admin/dashboard";
import { requireArea } from "@/lib/auth/session";
import { ADMIN_CARRIER_PATHS, carrierAccountTab } from "@/lib/carriers/admin";
import { loadAdminCarriers, loadPendingDocuments, loadPendingVehicles } from "@/lib/carriers/admin-pages";
import { ORDER_STATUS_LABEL } from "@/lib/orders/status";
import { formatCents } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Amministrazione – Transigo" };

// Admin dashboard (spec 9): what needs the team now (links to the queues), the money of a month in Europe/Rome and
// the orders by status. Read with the admin's session (RLS). Payouts on hold — with stage 6; until then the carrier
// amount is the expected one (from the order snapshot).
export default function Page({ searchParams }: PageProps<"/admin">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

type MonthOrder = {
  status: string;
  order_charges: { total_cents: number; subtotal_cents: number; refunded_cents: number } | null;
  order_legs: { order_leg_carrier_terms: { carrier_amount_cents: number } | null }[];
  // Facchinaggio (D152): the carrier amount hangs off the porter job (foreign key to order_porter_jobs)
  order_porter_jobs: { order_porter_carrier_terms: { carrier_amount_cents: number } | null } | null;
  order_cancellation_decisions: { carrier_cents: number } | null;
};

const STATUS_ORDER = ["pending_payment", "payment_review", "paid", "assigned", "picked_up", "in_transit", "delivered", "completed", "cancellation_review", "cancelled", "refunded", "expired"];

async function Content({ searchParams }: Pick<PageProps<"/admin">, "searchParams">) {
  const ctx = await requireArea("admin", "/admin");
  await connection();
  const now = new Date();
  const month = romeMonthRange((await searchParams).mese, now);
  const db = await createClient(); // admin's session (RLS)
  const head = { count: "exact" as const, head: true };

  const [
    settings, cancellations, reviewPayments, openRefunds, claims, handover, paidOrders, requests, carriers, vehicles, documents, docs, monthOrders, statuses, invoiceErrors,
  ] = await Promise.all([
    db.from("settings").select("unassigned_alert_hours").single(),
    db.from("orders").select("id", head).eq("status", "cancellation_review"),
    db.from("payments").select("order_id").eq("status", "succeeded").not("review_reason", "is", null).is("reviewed_at", null),
    db.from("refunds").select("id, status, retry_of").neq("status", "succeeded"),
    db.from("claims").select("id", head).eq("status", "open"),
    db.from("orders").select("id", head).in("status", ["picked_up", "in_transit"]).is("carrier_id", null).not("handover_required_at", "is", null),
    db.from("orders").select("status, carrier_id, paid_at").eq("status", "paid").is("carrier_id", null).neq("service_type", "storage"), // storage: never a carrier (D152)
    db.from("contact_requests").select("id", head).eq("status", "new"),
    loadAdminCarriers(db),
    loadPendingVehicles(db),
    loadPendingDocuments(db),
    db.from("carrier_documents").select("carrier_id, vehicle_id, doc_type, expires_at, review_status, created_at, carriers!inner(status), carrier_vehicles(is_active)")
      .not("expires_at", "is", null).in("carriers.status", ["active", "suspended"]),
    db.from("orders")
      .select("status, order_charges(total_cents, subtotal_cents, refunded_cents), order_legs(order_leg_carrier_terms(carrier_amount_cents)), order_porter_jobs(order_porter_carrier_terms(carrier_amount_cents)), order_cancellation_decisions(carrier_cents)")
      .gte("paid_at", month.start.toISOString()).lt("paid_at", month.end.toISOString())
      .returns<MonthOrder[]>(),
    db.from("orders").select("status").limit(10_000),
    db.from("invoices").select("id", head).eq("status", "failed"),
  ]);

  const alertHours = settings.data?.unassigned_alert_hours ?? 4;
  const retried = new Set((openRefunds.data ?? []).map((r) => r.retry_of).filter(Boolean));
  const refundsToComplete = (openRefunds.data ?? []).filter((r) => r.status === "pending" || !retried.has(r.id)).length;
  const expiring = expiringDocuments(
    ((docs.data ?? []) as unknown as (DocLike & { carrier_vehicles: { is_active: boolean } | null })[]).filter((d) => !d.vehicle_id || d.carrier_vehicles?.is_active),
    now,
  );
  const carriersToReview = carriers.filter((c) => carrierAccountTab(c.status, c.submitted_at) === "da-verificare").length;

  const tiles: { label: string; count: number | null; href: string; hint?: string }[] = [
    { label: "Annullamenti da decidere", count: cancellations.count, href: "/admin/ordini?filtro=annullamento" },
    { label: "Pagamenti da verificare", count: new Set((reviewPayments.data ?? []).map((p) => p.order_id)).size, href: "/admin/ordini?filtro=da-verificare" },
    { label: "Rimborsi da completare", count: refundsToComplete, href: "/admin/ordini?filtro=rimborsi" },
    { label: "Ordini da gestire", count: handover.count, href: "/admin/ordini?filtro=da-gestire", hint: "padroncino rimosso con la merce" },
    { label: `Pagati senza padroncino da oltre ${alertHours} h`, count: unassignedTooLong(paidOrders.data ?? [], alertHours, now), href: "/admin/ordini?filtro=da-assegnare" },
    { label: "Fatture in errore", count: invoiceErrors.count, href: "/admin/fatture" },
    { label: "Reclami aperti", count: claims.count, href: "/admin/reclami" },
    { label: "Richieste nuove", count: requests.count, href: "/admin/richieste" },
    { label: "Padroncini da verificare", count: carriersToReview, href: ADMIN_CARRIER_PATHS.tab("da-verificare") },
    { label: "Veicoli da verificare", count: vehicles.length, href: ADMIN_CARRIER_PATHS.tab("veicoli") },
    { label: "Documenti da verificare", count: documents.length, href: ADMIN_CARRIER_PATHS.tab("documenti") },
    { label: "Documenti in scadenza (30 giorni)", count: expiring.length, href: ADMIN_CARRIER_PATHS.tab("attivi"), hint: "padroncini attivi o sospesi" },
  ];
  const loadErrors = [settings, cancellations, reviewPayments, openRefunds, claims, handover, paidOrders, requests, docs, monthOrders, statuses, invoiceErrors].filter((r) => r.error).length;

  const finance = monthFinance(
    (monthOrders.data ?? []).map((o): FinanceOrder => ({
      status: o.status,
      total_cents: o.order_charges?.total_cents ?? 0,
      subtotal_cents: o.order_charges?.subtotal_cents ?? 0,
      refunded_cents: o.order_charges?.refunded_cents ?? 0,
      carrier_amount_cents: o.order_legs.reduce((s, l) => s + (l.order_leg_carrier_terms?.carrier_amount_cents ?? 0), 0)
        + (o.order_porter_jobs?.order_porter_carrier_terms?.carrier_amount_cents ?? 0),
      cancellation_carrier_cents: o.order_cancellation_decisions?.carrier_cents ?? null,
    })),
  );
  const byStatus = new Map<string, number>();
  for (const o of statuses.data ?? []) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);

  return (
    <AdminShell title={`Ciao${ctx.firstName ? `, ${ctx.firstName}` : ""}!`}>
      {loadErrors ? <p role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-800">Alcuni dati non sono stati caricati. Ricarica la pagina.</p> : null}

      <section aria-labelledby="todo">
        <h2 id="todo" className="mb-3 text-lg font-semibold text-zinc-900">Da gestire</h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map((t) => {
            const todo = (t.count ?? 0) > 0;
            return (
              <li key={t.label}>
                <Link href={t.href} className={`block rounded-md border p-3 hover:bg-zinc-50 ${todo ? "border-amber-300" : "border-zinc-200"}`}>
                  <span className="block text-2xl font-semibold tabular-nums text-zinc-900">{t.count ?? "—"}</span>
                  <span className="block text-sm text-zinc-800">{t.label}</span>
                  <span className={`mt-1 block text-xs ${todo ? "font-medium text-amber-900" : "text-zinc-500"}`}>
                    {todo ? "Da fare" : "Niente da fare"}{t.hint ? ` · ${t.hint}` : ""}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="money" className="mt-10">
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 id="money" className="text-lg font-semibold text-zinc-900">Incassi di {month.label}</h2>
          <nav className="flex gap-3 text-sm">
            <Link href={`/admin?mese=${month.prev}`} className="text-blue-700 hover:underline">← mese precedente</Link>
            {month.next ? <Link href={`/admin?mese=${month.next}`} className="text-blue-700 hover:underline">mese successivo →</Link> : null}
          </nav>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Incassato (IVA inclusa)" value={formatCents(finance.grossCents)} note={`${finance.orders} ordini pagati${finance.refundedCents ? `, rimborsi ${formatCents(finance.refundedCents)}` : ""}`} />
          <Stat label="Ricavi netti (senza IVA)" value={formatCents(finance.netCents)} />
          <Stat label="Quota padroncini (stima)" value={formatCents(finance.carrierCents)} note="pagamenti automatici: fase successiva" />
          <Stat label="Margine" value={formatCents(finance.marginCents)} note="ricavi netti − quota padroncini (stima)" />
        </dl>
        <p className="mt-2 text-xs text-zinc-500">Ordini con pagamento confermato nel mese (ora di Roma). Rimborsi: solo quelli già confermati da Stripe.</p>
      </section>

      <section aria-labelledby="statuses" className="mt-10">
        <h2 id="statuses" className="mb-3 text-lg font-semibold text-zinc-900">Ordini per stato (tutti)</h2>
        <table className="w-full max-w-md text-sm">
          <tbody>
            {STATUS_ORDER.filter((s) => byStatus.has(s)).map((s) => (
              <tr key={s} className="border-t border-zinc-100">
                <td className="py-1 pr-3">{ORDER_STATUS_LABEL[s] ?? s}</td>
                <td className="py-1 text-right tabular-nums">{byStatus.get(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AdminShell>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-md border border-zinc-200 p-3">
      <dt className="text-sm text-zinc-600">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{value}</dd>
      {note ? <dd className="mt-1 text-xs text-zinc-500">{note}</dd> : null}
    </div>
  );
}
