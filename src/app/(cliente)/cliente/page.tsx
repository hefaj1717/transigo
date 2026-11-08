import { Suspense } from "react";
import Link from "next/link";
import { Loading, PanelShell } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";
import { ORDER_STATUS_LABEL, PAYMENT_STATE_LABEL, paymentState } from "@/lib/orders/status";
import { formatCents } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import { PayNowButton } from "./ordini/order-actions";
import { ResumeBooking } from "./resume-booking";

export const metadata = { title: "Area cliente – Transigo" };

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  pickup_window_start: string;
  created_at: string;
  payment_due_at: string;
  paid_at: string | null;
  order_charges: { total_cents: number; refunded_cents: number } | null;
};

async function Content() {
  const ctx = await requireArea("cliente", "/cliente");
  // The customer's own client: RLS returns only their orders and never carrier amounts (D29, D77).
  const supabase = await createClient();
  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, order_number, status, pickup_window_start, created_at, payment_due_at, paid_at, order_charges(total_cents, refunded_cents)")
    .order("created_at", { ascending: false })
    .limit(50)
    .returns<OrderRow[]>();

  const now = new Date();
  return (
    <PanelShell title={`Ciao${ctx.firstName ? `, ${ctx.firstName}` : ""}!`}>
      <ResumeBooking />
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-zinc-900">I miei ordini</h2>
        <Link href="/prenota" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Nuova prenotazione</Link>
      </div>
      {error ? <p className="mt-4 text-sm text-red-700">Non è stato possibile caricare gli ordini.</p> : null}
      {orders && orders.length ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Ordine</th>
                <th className="py-2 pr-4 font-medium">Ritiro</th>
                <th className="py-2 pr-4 font-medium">Stato</th>
                <th className="py-2 pr-4 font-medium">Pagamento</th>
                <th className="py-2 text-right font-medium">Totale</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const pay = paymentState({ ...o, refunded_cents: o.order_charges?.refunded_cents, total_cents: o.order_charges?.total_cents }, now);
                return (
                <tr key={o.id} className="border-t border-zinc-100">
                  <td className="py-2 pr-4 font-medium text-zinc-900">
                    <Link href={`/cliente/ordini/${o.id}`} className="text-blue-700 underline">{o.order_number}</Link>
                  </td>
                  <td className="py-2 pr-4">{new Date(o.pickup_window_start).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "medium", timeStyle: "short" })}</td>
                  <td className="py-2 pr-4">{ORDER_STATUS_LABEL[o.status] ?? o.status}</td>
                  <td className="py-2 pr-4">
                    <span className="mr-2">{PAYMENT_STATE_LABEL[pay]}</span>
                    {pay === "to_pay" ? <PayNowButton orderId={o.id} compact /> : null}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">{o.order_charges ? formatCents(o.order_charges.total_cents) : "—"}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : !error ? (
        <p className="mt-4 text-sm text-zinc-600">Non hai ancora ordini.</p>
      ) : null}
    </PanelShell>
  );
}
