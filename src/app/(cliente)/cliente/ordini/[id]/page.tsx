import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CustomerShell, StatusBadge } from "@/components/cliente/customer-shell";
import { Loading } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";
import { CUSTOMER_STATUS_LABEL, progressSteps, routeSummary, type ProgressStep } from "@/lib/orders/customer-view";
import { paymentState } from "@/lib/orders/status";
import { formatCents } from "@/lib/pricing/money";
import { PORTER_PACKAGE_LABEL } from "@/lib/pricing/rule-meta";
import type { PorterPackageCode } from "@/lib/pricing/types";
import { createClient } from "@/lib/supabase/server";
import { CancelUnpaidButton, PaymentPending, PayNowButton } from "../order-actions";

export const metadata = { title: "Ordine – Transigo" };

// Order page of the customer (spec 7): progress, carrier (customer_order_carrier — first name, company,
// vehicle, plate only), price breakdown (D3), route with floors and contacts, goods, services, history.
// Return URL of Stripe Checkout: ?pagamento=ok only shows "Pagamento in verifica" — the status changes only
// through the webhook (D89). Everything is read with the customer's own session (RLS, D77).
export default function Page({ params, searchParams }: PageProps<"/cliente/ordini/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} searchParams={searchParams} />
    </Suspense>
  );
}

type Leg = {
  leg_index: number; pickup_address: string; delivery_address: string; pickup_city: string; delivery_city: string;
  pickup_window_start: string; pickup_window_end: string; pickup_floor: number; pickup_has_elevator: boolean;
  delivery_floor: number; delivery_has_elevator: boolean; distance_m: number; is_urgent: boolean;
  porter_package_code: PorterPackageCode | null; porters_count: number; porters_included_hours: number | null;
  pickup_warehouse_id: string | null; delivery_warehouse_id: string | null;
};
type OrderRow = {
  id: string; order_number: string; status: string; payment_due_at: string; paid_at: string | null; created_at: string;
  assigned_at: string | null; picked_up_at: string | null; in_transit_at: string | null; delivered_at: string | null;
  delivered_without_pod: boolean;
  goods_description: string; items_count: number | null; weight_kg: number | null; goods_dimensions_note: string | null;
  largest_item_length_cm: number | null; largest_item_width_cm: number | null; largest_item_height_cm: number | null;
  pallets_count: number | null; load_category: PorterPackageCode | null; packing_items_count: number;
  storage_type: "transshipment" | "short_term" | "long_term" | null; storage_days: number | null; storage_pallets: number | null;
  pickup_contact_name: string; pickup_contact_phone: string; delivery_contact_name: string; delivery_contact_phone: string;
  customer_notes: string | null;
  vehicle_types: { name_it: string } | null;
  order_charges: { total_cents: number; subtotal_cents: number; vat_cents: number; refunded_cents: number; customer_type: "private" | "business" } | null;
  order_lines: { sort_order: number; label_it: string; net_cents: number; gross_cents: number }[];
  order_legs: Leg[];
  order_status_history: { id: number; to_status: string; created_at: string; note: string | null }[];
};
type CarrierInfo = { first_name: string | null; company_name: string; vehicle_type: string | null; plate: string | null };

const SELECT = [
  "id, order_number, status, payment_due_at, paid_at, created_at, assigned_at, picked_up_at, in_transit_at, delivered_at, delivered_without_pod",
  "goods_description, items_count, weight_kg, goods_dimensions_note, largest_item_length_cm, largest_item_width_cm, largest_item_height_cm",
  "pallets_count, load_category, packing_items_count, storage_type, storage_days, storage_pallets",
  "pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone, customer_notes",
  "vehicle_types(name_it)",
  "order_charges(total_cents, subtotal_cents, vat_cents, refunded_cents, customer_type)",
  "order_lines(sort_order, label_it, net_cents, gross_cents)",
  "order_legs(leg_index, pickup_address, delivery_address, pickup_city, delivery_city, pickup_window_start, pickup_window_end, pickup_floor, pickup_has_elevator, delivery_floor, delivery_has_elevator, distance_m, is_urgent, porter_package_code, porters_count, porters_included_hours, pickup_warehouse_id, delivery_warehouse_id)",
  "order_status_history(id, to_status, created_at, note)",
].join(", ");

const rome = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", ...opts });
const time = (iso: string) => rome(iso, { hour: "2-digit", minute: "2-digit" });
const num = new Intl.NumberFormat("it-IT");
const floor = (n: number, lift: boolean) => (n === 0 ? "Piano terra" : `${n}° piano, ${lift ? "con ascensore" : "senza ascensore"}`);

async function Content({ params, searchParams }: Pick<PageProps<"/cliente/ordini/[id]">, "params" | "searchParams">) {
  const { id } = await params;
  const sp = await searchParams;
  await requireArea("cliente", `/cliente/ordini/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const [{ data: o }, carrierRes] = await Promise.all([
    supabase.from("orders").select(SELECT).eq("id", id).maybeSingle<OrderRow>(),
    supabase.rpc("customer_order_carrier", { p_order_id: id }),
  ]);
  if (!o) notFound();
  const carrier = ((carrierRes.data ?? []) as CarrierInfo[])[0] ?? null;

  const now = new Date();
  const legs = [...o.order_legs].sort((a, b) => a.leg_index - b.leg_index);
  const lines = [...o.order_lines].sort((a, b) => a.sort_order - b.sort_order);
  const history = [...o.order_status_history].sort((a, b) => a.id - b.id);
  const charges = o.order_charges;
  const business = charges?.customer_type === "business";
  const pay = paymentState({ ...o, refunded_cents: charges?.refunded_cents, total_cents: charges?.total_cents }, now);
  const progress = progressSteps(o);
  const returnedFromCheckout = sp.pagamento === "ok";
  const cancelledCheckout = sp.pagamento === "annullato";
  const paidAndOpen = ["paid", "assigned"].includes(o.status);

  return (
    <CustomerShell
      title={routeSummary(legs)}
      subtitle={<>Ordine {o.order_number} · creato il {rome(o.created_at, { dateStyle: "medium" })}</>}
    >
      <p className="-mt-2 mb-5 text-sm">
        <Link href="/cliente" className="font-medium text-brand-700 hover:text-brand-900">← I miei ordini</Link>
      </p>

      <div className="space-y-5">
        {/* Status + payment */}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <StatusBadge status={o.status} />
              {o.status === "delivered" && o.delivered_without_pod ? <span className="text-xs text-zinc-500">Consegna confermata dal nostro team</span> : null}
            </div>
            {charges ? (
              <p className="text-right">
                <span className="text-xl font-bold text-brand-900">{formatCents(charges.total_cents)}</span>
                <span className="block text-xs text-zinc-500">{business ? "IVA inclusa nel totale" : "IVA inclusa"}</span>
              </p>
            ) : null}
          </div>
          {progress ? <Progress steps={progress} /> : null}

          <div className="mt-4 space-y-3">
            {pay === "to_pay" && returnedFromCheckout ? <PaymentPending /> : null}
            {pay === "to_pay" && !returnedFromCheckout ? (
              <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
                {cancelledCheckout ? <p className="text-sm text-zinc-800">Il pagamento non è stato completato. Puoi riprovare.</p> : null}
                <p className="text-sm text-zinc-800">
                  Completa il pagamento entro le <strong>{time(o.payment_due_at)}</strong> del {rome(o.payment_due_at, { dateStyle: "medium" })}. Dopo, l&apos;ordine scade e il prezzo andrà ricalcolato.
                </p>
                <div className="flex flex-wrap items-start gap-3">
                  <PayNowButton orderId={o.id} />
                  <CancelUnpaidButton orderId={o.id} />
                </div>
              </div>
            ) : null}
            {pay === "overdue" ? <Note tone="warning">Il tempo per il pagamento è scaduto. <Link href="/prenota" className="underline">Prenota di nuovo</Link> per ricevere un nuovo preventivo.</Note> : null}
            {pay === "review" ? <Note tone="warning">Abbiamo ricevuto un pagamento che il nostro team deve verificare. Ti contatteremo a breve; non serve pagare di nuovo.</Note> : null}
            {pay === "paid" && returnedFromCheckout ? <Note tone="success">Pagamento confermato. Grazie! Ti abbiamo inviato un&apos;e-mail di conferma.</Note> : null}
            {o.paid_at ? <p className="text-xs text-zinc-500">Pagato il {rome(o.paid_at, { dateStyle: "medium", timeStyle: "short" })}</p> : null}
          </div>
        </Card>

        {/* Carrier */}
        {carrier ? (
          <Card>
            <H2>Il tuo trasportatore</H2>
            <p className="mt-2 text-zinc-900">
              <span className="font-semibold">{carrier.first_name ?? carrier.company_name}</span>
              {carrier.first_name ? <span className="text-zinc-600"> · {carrier.company_name}</span> : null}
            </p>
            {carrier.vehicle_type || carrier.plate ? (
              <p className="mt-1 text-sm text-zinc-600">
                {carrier.vehicle_type}
                {carrier.plate ? <> · targa <span className="font-mono font-semibold text-zinc-900">{carrier.plate}</span></> : null}
              </p>
            ) : null}
            <p className="mt-3 text-xs text-zinc-500">Per qualsiasi necessità sul trasporto <Link href="/contatti" className="underline">contattaci</Link>: siamo noi il tuo riferimento.</p>
          </Card>
        ) : o.status === "paid" ? (
          <Card>
            <H2>Il tuo trasportatore</H2>
            <p className="mt-2 text-sm text-zinc-600">Stiamo assegnando il trasporto a uno dei nostri trasportatori verificati. Ti avviseremo appena è confermato.</p>
          </Card>
        ) : null}

        {/* Route */}
        <Card>
          <H2>Percorso</H2>
          <ol className="mt-3 space-y-4">
            {legs.map((l) => (
              <li key={l.leg_index} className="rounded-lg bg-zinc-50 p-4">
                {legs.length > 1 ? <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{l.leg_index === 0 ? "1. Ritiro → deposito" : "2. Deposito → consegna"}</p> : null}
                <p className="text-sm text-zinc-900">
                  {rome(l.pickup_window_start, { weekday: "long", day: "numeric", month: "long" })}, {time(l.pickup_window_start)}–{time(l.pickup_window_end)}
                  {l.is_urgent ? <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">Urgente</span> : null}
                </p>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  <Place title="Ritiro" address={l.pickup_address} detail={l.pickup_warehouse_id ? "Nostro magazzino" : floor(l.pickup_floor, l.pickup_has_elevator)} />
                  <Place title="Consegna" address={l.delivery_address} detail={l.delivery_warehouse_id ? "Nostro magazzino" : floor(l.delivery_floor, l.delivery_has_elevator)} />
                </dl>
                <p className="mt-2 text-xs text-zinc-500">{num.format(Math.round(l.distance_m / 100) / 10)} km</p>
              </li>
            ))}
          </ol>
          <dl className="mt-4 grid gap-3 border-t border-zinc-100 pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-zinc-500">Contatto al ritiro</dt>
              <dd className="text-zinc-900">{o.pickup_contact_name} · {o.pickup_contact_phone}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Contatto alla consegna</dt>
              <dd className="text-zinc-900">{o.delivery_contact_name} · {o.delivery_contact_phone}</dd>
            </div>
            {o.customer_notes ? (
              <div className="sm:col-span-2">
                <dt className="text-zinc-500">Note</dt>
                <dd className="whitespace-pre-line text-zinc-900">{o.customer_notes}</dd>
              </div>
            ) : null}
          </dl>
        </Card>

        {/* Goods and services */}
        <Card>
          <H2>Merce e servizi</H2>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row k="Merce" v={o.goods_description} />
            {o.load_category ? <Row k="Tipo di trasporto" v={PORTER_PACKAGE_LABEL[o.load_category]} /> : null}
            {o.items_count ? <Row k="Colli" v={num.format(o.items_count)} /> : null}
            {o.weight_kg ? <Row k="Peso totale" v={`${num.format(o.weight_kg)} kg`} /> : null}
            {o.largest_item_length_cm && o.largest_item_width_cm && o.largest_item_height_cm ? (
              <Row k="Oggetto più grande" v={`${o.largest_item_length_cm} × ${o.largest_item_width_cm} × ${o.largest_item_height_cm} cm`} />
            ) : null}
            {o.pallets_count ? <Row k="Pallet EUR" v={String(o.pallets_count)} /> : null}
            {o.vehicle_types ? <Row k="Veicolo" v={o.vehicle_types.name_it} /> : null}
            {legs.filter((l) => l.porters_count > 0).map((l) => (
              <Row
                key={`p${l.leg_index}`}
                k={legs.length > 1 ? `Facchini (${l.leg_index === 0 ? "ritiro" : "consegna"})` : "Facchini"}
                v={`${l.porters_count} ${l.porters_count === 1 ? "persona" : "persone"}${l.porters_included_hours ? `, ${l.porters_included_hours} h incluse` : ""}${l.porter_package_code ? ` · ${PORTER_PACKAGE_LABEL[l.porter_package_code]}` : ""}`}
              />
            ))}
            {o.packing_items_count > 0 ? <Row k="Imballaggio" v={`${o.packing_items_count} colli`} /> : null}
            {o.storage_type ? (
              <Row k="Deposito" v={o.storage_type === "transshipment" ? "Transbordo (stesso giorno)" : `${o.storage_days} giorni${o.storage_pallets ? `, ${o.storage_pallets} pallet` : ""}`} />
            ) : null}
          </dl>
        </Card>

        {/* Price */}
        {charges && lines.length ? (
          <Card>
            <H2>Prezzo</H2>
            <table className="mt-3 w-full text-sm">
              <tbody>
                {lines.map((l) => (
                  <tr key={l.sort_order} className="border-b border-zinc-100">
                    <td className="py-2 pr-3 text-zinc-700">{l.label_it}</td>
                    <td className="py-2 text-right whitespace-nowrap text-zinc-900">{formatCents(business ? l.net_cents : l.gross_cents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {business ? (
                  <>
                    <tr><td className="pt-3 pr-3 text-zinc-500">Imponibile</td><td className="pt-3 text-right">{formatCents(charges.subtotal_cents)}</td></tr>
                    <tr><td className="pr-3 text-zinc-500">IVA</td><td className="text-right">{formatCents(charges.vat_cents)}</td></tr>
                  </>
                ) : null}
                <tr>
                  <td className="pt-2 pr-3 font-semibold text-zinc-900">Totale{business ? "" : " (IVA inclusa)"}</td>
                  <td className="pt-2 text-right font-bold text-brand-900">{formatCents(charges.total_cents)}</td>
                </tr>
                {charges.refunded_cents > 0 ? (
                  <tr><td className="pr-3 text-zinc-500">Rimborsato</td><td className="text-right text-zinc-700">−{formatCents(charges.refunded_cents)}</td></tr>
                ) : null}
              </tfoot>
            </table>
          </Card>
        ) : null}

        {/* Changes */}
        {paidAndOpen ? (
          <Note tone="info">
            Devi modificare o annullare l&apos;ordine? <Link href="/contatti" className="font-medium underline">Contattaci</Link> indicando il numero {o.order_number}.
          </Note>
        ) : null}

        {/* History */}
        <Card>
          <H2>Cronologia</H2>
          <ol className="mt-3 space-y-2 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex gap-3">
                <span className="w-32 shrink-0 text-zinc-500">{rome(h.created_at, { dateStyle: "short", timeStyle: "short" })}</span>
                <span className="text-zinc-900">
                  {CUSTOMER_STATUS_LABEL[h.to_status] ?? h.to_status}
                  {h.note ? <span className="text-zinc-500"> — {h.note}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </CustomerShell>
  );
}

function H2({ children }: { children: ReactNode }) {
  return <h2 className="text-lg font-semibold text-brand-900">{children}</h2>;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-zinc-500">{k}</dt>
      <dd className="text-zinc-900">{v}</dd>
    </div>
  );
}

function Place({ title, address, detail }: { title: string; address: string; detail: string }) {
  return (
    <div>
      <dt className="text-zinc-500">{title}</dt>
      <dd className="text-zinc-900">{address}</dd>
      <dd className="text-xs text-zinc-500">{detail}</dd>
    </div>
  );
}

const NOTE_TONE = {
  info: "bg-brand-50 text-brand-900",
  warning: "bg-amber-50 text-amber-900",
  success: "bg-accent-50 text-accent-900",
} as const;

function Note({ tone, children }: { tone: keyof typeof NOTE_TONE; children: ReactNode }) {
  return <p role={tone === "success" ? "status" : undefined} className={`rounded-md p-3 text-sm ${NOTE_TONE[tone]}`}>{children}</p>;
}

function Progress({ steps }: { steps: ProgressStep[] }) {
  return (
    <ol className="mt-5 grid grid-cols-5 gap-1" aria-label="Avanzamento dell'ordine">
      {steps.map((s) => (
        <li key={s.key} className="flex flex-col gap-1.5" aria-current={s.state === "current" ? "step" : undefined}>
          <span className={`h-1.5 rounded-full ${s.state === "done" ? "bg-accent-500" : s.state === "current" ? "bg-brand-600" : "bg-zinc-200"}`} />
          <span className={`text-[11px] leading-tight sm:text-xs ${s.state === "todo" ? "text-zinc-400" : "font-medium text-zinc-800"}`}>{s.label}</span>
          {s.at ? <span className="hidden text-[11px] text-zinc-500 sm:block">{rome(s.at, { day: "numeric", month: "short" })}, {time(s.at)}</span> : null}
        </li>
      ))}
    </ol>
  );
}
