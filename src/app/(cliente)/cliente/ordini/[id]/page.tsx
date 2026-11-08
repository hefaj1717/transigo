import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Loading, PanelShell } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";
import { ORDER_STATUS_LABEL, PAYMENT_STATE_LABEL, paymentState } from "@/lib/orders/status";
import { formatCents } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import { CancelUnpaidButton, PaymentPending, PayNowButton } from "../order-actions";

export const metadata = { title: "Ordine – Transigo" };

// Order page of the customer (spec 7, Stage 3 scope: status, price, payment). Return URL of Stripe Checkout:
// ?pagamento=ok only shows "Pagamento in verifica" — the status changes only through the webhook (D89).
export default function Page({ params, searchParams }: PageProps<"/cliente/ordini/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} searchParams={searchParams} />
    </Suspense>
  );
}

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  payment_due_at: string;
  paid_at: string | null;
  created_at: string;
  goods_description: string;
  order_charges: { total_cents: number; subtotal_cents: number; vat_cents: number; refunded_cents: number; customer_type: "private" | "business" } | null;
  order_legs: { leg_index: number; pickup_address: string; delivery_address: string; pickup_window_start: string; pickup_window_end: string }[];
  order_status_history: { id: number; to_status: string; created_at: string; note: string | null }[];
};

const rome = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", ...opts });

async function Content({ params, searchParams }: Pick<PageProps<"/cliente/ordini/[id]">, "params" | "searchParams">) {
  const { id } = await params;
  const sp = await searchParams;
  await requireArea("cliente", `/cliente/ordini/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  // The customer's own client: RLS returns the order only if it is theirs (D77).
  const supabase = await createClient();
  const { data: o } = await supabase
    .from("orders")
    .select(
      "id, order_number, status, payment_due_at, paid_at, created_at, goods_description, order_charges(total_cents, subtotal_cents, vat_cents, refunded_cents, customer_type), order_legs(leg_index, pickup_address, delivery_address, pickup_window_start, pickup_window_end), order_status_history(id, to_status, created_at, note)",
    )
    .eq("id", id)
    .maybeSingle<OrderRow>();
  if (!o) notFound();

  const now = new Date();
  const legs = [...o.order_legs].sort((a, b) => a.leg_index - b.leg_index);
  const history = [...o.order_status_history].sort((a, b) => a.id - b.id);
  const charges = o.order_charges;
  const pay = paymentState({ ...o, refunded_cents: charges?.refunded_cents, total_cents: charges?.total_cents }, now);
  const returnedFromCheckout = sp.pagamento === "ok";
  const cancelledCheckout = sp.pagamento === "annullato";

  return (
    <PanelShell title={`Ordine ${o.order_number}`}>
      <p className="text-sm">
        <Link href="/cliente" className="text-blue-700 underline">← I miei ordini</Link>
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 p-4">
          <p className="text-sm text-zinc-500">Stato</p>
          <p className="text-lg font-semibold text-zinc-900">{ORDER_STATUS_LABEL[o.status] ?? o.status}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 p-4">
          <p className="text-sm text-zinc-500">Pagamento</p>
          <p className="text-lg font-semibold text-zinc-900">{PAYMENT_STATE_LABEL[pay]}</p>
          {charges ? <p className="text-sm text-zinc-600">Totale {formatCents(charges.total_cents)}{charges.customer_type === "business" ? ` (imponibile ${formatCents(charges.subtotal_cents)} + IVA ${formatCents(charges.vat_cents)})` : " IVA inclusa"}</p> : null}
          {o.paid_at ? <p className="text-sm text-zinc-600">Pagato il {rome(o.paid_at, { dateStyle: "medium", timeStyle: "short" })}</p> : null}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {pay === "to_pay" && returnedFromCheckout ? <PaymentPending /> : null}
        {pay === "to_pay" && !returnedFromCheckout ? (
          <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/50 p-4">
            {cancelledCheckout ? <p className="text-sm text-zinc-800">Il pagamento non è stato completato. Puoi riprovare.</p> : null}
            <p className="text-sm text-zinc-800">
              Completa il pagamento entro le <strong>{rome(o.payment_due_at, { hour: "2-digit", minute: "2-digit" })}</strong> del {rome(o.payment_due_at, { dateStyle: "medium" })}. Dopo, l&apos;ordine scade e il prezzo andrà ricalcolato.
            </p>
            <div className="flex flex-wrap items-start gap-3">
              <PayNowButton orderId={o.id} />
              <CancelUnpaidButton orderId={o.id} />
            </div>
          </div>
        ) : null}
        {pay === "overdue" ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">Il tempo per il pagamento è scaduto. <Link href="/prenota" className="underline">Prenota di nuovo</Link> per ricevere un nuovo preventivo.</p> : null}
        {pay === "review" ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">Abbiamo ricevuto un pagamento che il nostro team deve verificare. Ti contatteremo a breve; non serve pagare di nuovo.</p> : null}
        {pay === "paid" && returnedFromCheckout ? <p role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-900">Pagamento confermato. Grazie! Ti abbiamo inviato un&apos;e-mail di conferma.</p> : null}
      </div>

      <h2 className="mt-8 text-lg font-semibold text-zinc-900">Percorso</h2>
      <ul className="mt-2 space-y-2 text-sm">
        {legs.map((l) => (
          <li key={l.leg_index} className="rounded-md border border-zinc-200 p-3">
            <p>
              <span className="text-zinc-500">Ritiro:</span> {l.pickup_address}
            </p>
            <p>
              <span className="text-zinc-500">Consegna:</span> {l.delivery_address}
            </p>
            <p className="text-zinc-600">
              {rome(l.pickup_window_start, { dateStyle: "full" })}, {rome(l.pickup_window_start, { hour: "2-digit", minute: "2-digit" })}–{rome(l.pickup_window_end, { hour: "2-digit", minute: "2-digit" })}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-zinc-600">Merce: {o.goods_description}</p>

      <h2 className="mt-8 text-lg font-semibold text-zinc-900">Cronologia</h2>
      <ol className="mt-2 space-y-1 text-sm">
        {history.map((h) => (
          <li key={h.id}>
            <span className="text-zinc-500">{rome(h.created_at, { dateStyle: "short", timeStyle: "short" })}</span> — {ORDER_STATUS_LABEL[h.to_status] ?? h.to_status}
            {h.note ? <span className="text-zinc-500"> ({h.note})</span> : null}
          </li>
        ))}
      </ol>
    </PanelShell>
  );
}
