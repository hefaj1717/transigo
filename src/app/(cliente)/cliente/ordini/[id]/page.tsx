import { Suspense, type ReactNode } from "react";
import { shipmentText } from "@/lib/orders/shipment";
import type { ShipmentCategory } from "@/lib/booking/state";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CustomerShell, StatusBadge } from "@/components/cliente/customer-shell";
import { CUSTOMER_DOC_COLUMNS, InvoiceList, type CustomerDoc } from "@/components/cliente/invoice-list";
import { groupDocuments } from "@/lib/einvoice/view";
import { Loading } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";
import { customerStatusLabel, orderTitle, progressSteps, type ProgressStep } from "@/lib/orders/customer-view";
import { bookingDays, bookingUnitLabel, CUSTOMER_STORAGE_INTAKE_LABEL, CUSTOMER_STORAGE_OUTBOUND_LABEL, formatDateOnly, serviceTypeOf } from "@/lib/orders/service-type";
import { loadCustomerExecution, type CustomerExecutionView } from "@/lib/orders/execution-read";
import { porterTimeSuffix } from "@/lib/carriers/execution";
import { groupPhotos, PHOTO_KIND_LABEL } from "@/lib/orders/execution-view";
import { canOpenClaim, claimDeadline } from "@/lib/claims/claims";
import { groupCancellationPreview, type CancellationInput, type CancellationPreview } from "@/lib/orders/cancellation";
import { OrderGroupCard } from "@/components/orders/order-group-card";
import { type GroupMemberRow } from "@/lib/orders/order-group";
import { loadOrderGroup } from "@/lib/orders/order-group-server";
import { loadCancellationSettings } from "@/lib/orders/cancellation-server";
import { paymentState } from "@/lib/orders/status";
import { formatCents } from "@/lib/pricing/money";
import { PORTER_PACKAGE_LABEL } from "@/lib/pricing/rule-meta";
import type { PorterPackageCode } from "@/lib/pricing/types";
import { createClient } from "@/lib/supabase/server";
import { BookingPhaseBadge } from "@/components/orders/booking-phase-badge";
import { bookingPhase, romeToday, type BookingPhase } from "@/lib/orders/booking-phase";
import { createServiceClient } from "@/lib/supabase/service";
import { CancelPaidOrder, CancelUnpaidButton, PaymentPending, PayNowButton } from "../order-actions";

export const metadata = { title: "Ordine – Transigo" };

// Order page of the customer (spec 7): progress, carrier (customer_order_carrier — first name, company,
// vehicle, plate only), proof of delivery (recipient, time, signature, photos — signed URLs of 5 min made with the
// customer's session; pickup photos already after loading) and porter working time, price breakdown (D3), route
// with floors and contacts, goods, services, history. Facchinaggio and Deposito orders (D151) have no legs: their
// job / booking replaces the route; the transport progress bar is not shown for them.
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
type PorterJob = {
  address: string; city: string; window_start: string; window_end: string; floor: number; has_elevator: boolean;
  persons: number; requested_hours: number; billed_hours: number; is_urgent: boolean;
};
type Booking = {
  unit: string; box_code: string | null; pallets: number | null; start_date: string; end_date: string;
  intake: string; outbound: string; status: string; // the warehouse is admin-only (RLS): its address via customer_order_warehouse() (D171)
};
type WarehouseInfo = { name: string; address: string; city: string; lat: number; lng: number };
/** A member of the order's group (D153), read with the customer's session. */
type GroupRow = GroupMemberRow & {
  status: string; pickup_window_start: string;
  order_charges: { total_cents: number } | null;
  order_lines: { line_type: string; gross_cents: number }[];
  refunds: { amount_cents: number; status: string }[];
  order_legs: { leg_index: number; pickup_city: string; delivery_city: string }[];
  order_porter_jobs: { city: string } | null;
  warehouse_bookings: { unit: string; box_code: string | null; pallets: number | null } | null;
};
const GROUP_SELECT =
  "status, pickup_window_start, order_charges(total_cents), order_lines(line_type, gross_cents), refunds(amount_cents, status), " +
  "order_legs(leg_index, pickup_city, delivery_city), order_porter_jobs(city), warehouse_bookings(unit, box_code, pallets)";
type OrderRow = {
  id: string; order_number: string; service_type: string; status: string; payment_due_at: string; paid_at: string | null; created_at: string; pickup_window_start: string;
  assigned_at: string | null; picked_up_at: string | null; in_transit_at: string | null; delivered_at: string | null;
  delivered_without_pod: boolean;
  goods_description: string; items_count: number | null; weight_kg: number | null; goods_dimensions_note: string | null;
  largest_item_length_cm: number | null; largest_item_width_cm: number | null; largest_item_height_cm: number | null;
  pallets_count: number | null; load_category: PorterPackageCode | null; shipment_category: ShipmentCategory | null; stackable: boolean | null; packing_items_count: number;
  storage_type: "transshipment" | "short_term" | "long_term" | null; storage_days: number | null; storage_pallets: number | null;
  // transport: both contacts; porters: on-site contact in pickup_*; storage: none
  pickup_contact_name: string | null; pickup_contact_phone: string | null; delivery_contact_name: string | null; delivery_contact_phone: string | null;
  customer_notes: string | null;
  vehicle_types: { name_it: string } | null;
  order_charges: { total_cents: number; subtotal_cents: number; vat_cents: number; refunded_cents: number; cancellation_fee_cents: number | null; customer_type: "private" | "business" } | null;
  order_lines: { sort_order: number; label_it: string; line_type: string; net_cents: number; gross_cents: number }[];
  refunds: { amount_cents: number; status: "pending" | "succeeded" | "failed" }[];
  claims: { id: string; status: "open" | "closed" }[];
  cancelled_at: string | null;
  order_legs: Leg[];
  order_porter_jobs: PorterJob | null;
  warehouse_bookings: Booking | null;
  order_status_history: { id: number; to_status: string; created_at: string; note: string | null }[];
};
type CarrierInfo = { first_name: string | null; company_name: string; vehicle_type: string | null; plate: string | null };

const SELECT = [
  "id, order_number, service_type, status, payment_due_at, paid_at, created_at, pickup_window_start, assigned_at, picked_up_at, in_transit_at, delivered_at, delivered_without_pod",
  "goods_description, items_count, weight_kg, goods_dimensions_note, largest_item_length_cm, largest_item_width_cm, largest_item_height_cm",
  "pallets_count, load_category, shipment_category, stackable, packing_items_count, storage_type, storage_days, storage_pallets",
  "pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone, customer_notes",
  "vehicle_types(name_it)",
  "cancelled_at",
  "order_charges(total_cents, subtotal_cents, vat_cents, refunded_cents, cancellation_fee_cents, customer_type)",
  "order_lines(sort_order, label_it, line_type, net_cents, gross_cents)",
  "refunds(amount_cents, status)",
  "claims(id, status)",
  "order_legs(leg_index, pickup_address, delivery_address, pickup_city, delivery_city, pickup_window_start, pickup_window_end, pickup_floor, pickup_has_elevator, delivery_floor, delivery_has_elevator, distance_m, is_urgent, porter_package_code, porters_count, porters_included_hours, pickup_warehouse_id, delivery_warehouse_id)",
  "order_porter_jobs(address, city, window_start, window_end, floor, has_elevator, persons, requested_hours, billed_hours, is_urgent)",
  "warehouse_bookings(unit, box_code, pallets, start_date, end_date, intake, outbound, status)",
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
  const [{ data: o }, carrierRes, docsRes] = await Promise.all([
    supabase.from("orders").select(SELECT).eq("id", id).maybeSingle<OrderRow>(),
    supabase.rpc("customer_order_carrier", { p_order_id: id }),
    supabase.from("invoices").select(CUSTOMER_DOC_COLUMNS).eq("order_id", id).returns<CustomerDoc[]>(),
  ]);
  if (!o) notFound();
  const invoiceGroups = groupDocuments(docsRes.data ?? []);
  const carrier = ((carrierRes.data ?? []) as CarrierInfo[])[0] ?? null;
  const exec = await loadCustomerExecution(supabase, o);
  // A storage chain (D153): the linked orders, one payment and one invoice on the first order.
  const loadedGroup = await loadOrderGroup<GroupRow>(supabase, id, GROUP_SELECT);
  const group = loadedGroup && loadedGroup.members.length > 1 ? loadedGroup : null;
  // D171: where to bring / collect the goods ("porto io" / "ritiro io").
  const booking = o.warehouse_bookings;
  const warehouse = booking && (booking.intake === "self" || booking.outbound !== "transigo")
    ? (((await supabase.rpc("customer_order_warehouse", { p_order_id: id })).data ?? []) as WarehouseInfo[])[0] ?? null
    : null;

  const now = new Date();
  const type = serviceTypeOf(o.service_type);
  const legs = [...o.order_legs].sort((a, b) => a.leg_index - b.leg_index);
  const lines = [...o.order_lines].sort((a, b) => a.sort_order - b.sort_order);
  const history = [...o.order_status_history].sort((a, b) => a.id - b.id);
  const charges = o.order_charges;
  const business = charges?.customer_type === "business";
  const pay = paymentState({ ...o, refunded_cents: charges?.refunded_cents, total_cents: charges?.total_cents }, now);
  // Transport: assigned → picked up → in transit → delivered; Facchinaggio without "In viaggio" (D165); Deposito: none.
  const progress = type === "storage" ? null : progressSteps(o, type);
  const returnedFromCheckout = sp.pagamento === "ok";
  const cancelledCheckout = sp.pagamento === "annullato";
  const paidAndOpen = group ? group.members.every((m) => m.status === "paid") : ["paid", "assigned"].includes(o.status);
  // D137 preview — the database recomputes the amounts on click. settings is admin-only: two numbers via service role.
  let cancel: { preview: CancellationPreview; freeHours: number; feeBp: number } | null = null;
  if (paidAndOpen && charges) {
    const s = await loadCancellationSettings(createServiceClient());
    const input = (m: Pick<GroupRow, "status" | "pickup_window_start" | "refunds" | "order_lines" | "service_type">, totalCents: number): CancellationInput => ({
      status: m.status, pickupWindowStart: new Date(m.pickup_window_start), now, freeHours: s.freeHours, feeBp: s.feeBp, totalCents,
      refundedCents: m.refunds.filter((r) => r.status !== "failed").reduce((sum, r) => sum + r.amount_cents, 0), lines: m.order_lines, serviceType: m.service_type,
    });
    // A chain is cancelled only as a whole (D169): the preview sums every order, as customer_cancel_order().
    const preview = group
      ? groupCancellationPreview(group.members.map((m) => input(m, m.order_charges?.total_cents ?? 0)))
      : groupCancellationPreview([input(o, charges.total_cents)]);
    cancel = { preview, ...s };
  }
  const refundTotal = o.refunds.filter((r) => r.status !== "failed").reduce((sum, r) => sum + r.amount_cents, 0);
  const refundPending = o.refunds.some((r) => r.status === "pending");

  return (
    <CustomerShell
      title={orderTitle(o)}
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
              <StatusBadge status={o.status} serviceType={o.service_type} />
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
            <H2>{type === "porters" ? "I tuoi facchini" : "Il tuo trasportatore"}</H2>
            <p className="mt-2 text-zinc-900">
              <span className="font-semibold">{carrier.first_name ?? carrier.company_name}</span>
              {carrier.first_name ? <span className="text-zinc-600"> · {carrier.company_name}</span> : null}
            </p>
            {type === "transport" && (carrier.vehicle_type || carrier.plate) ? (
              <p className="mt-1 text-sm text-zinc-600">
                {carrier.vehicle_type}
                {carrier.plate ? <> · targa <span className="font-mono font-semibold text-zinc-900">{carrier.plate}</span></> : null}
              </p>
            ) : null}
            <p className="mt-3 text-xs text-zinc-500">Per qualsiasi necessità {type === "porters" ? "sul servizio" : "sul trasporto"} <Link href="/contatti" className="underline">contattaci</Link>: siamo noi il tuo riferimento.</p>
          </Card>
        ) : o.status === "paid" && type === "transport" ? (
          <Card>
            <H2>Il tuo trasportatore</H2>
            <p className="mt-2 text-sm text-zinc-600">Stiamo assegnando il trasporto a uno dei nostri trasportatori verificati. Ti avviseremo appena è confermato.</p>
          </Card>
        ) : o.status === "paid" && type === "porters" ? (
          <Card>
            <H2>I tuoi facchini</H2>
            <p className="mt-2 text-sm text-zinc-600">Stiamo assegnando il servizio a una squadra verificata. Ti avviseremo appena è confermato.</p>
          </Card>
        ) : null}

        {o.order_porter_jobs ? <PorterJobCard job={o.order_porter_jobs} contact={o.pickup_contact_name ? `${o.pickup_contact_name} · ${o.pickup_contact_phone}` : null} notes={o.customer_notes} /> : null}
        {o.warehouse_bookings ? <BookingCard
            b={o.warehouse_bookings}
            warehouse={warehouse}
            phase={bookingPhase({
              orderStatus: o.status,
              booking: o.warehouse_bookings,
              intakeStatus: loadedGroup?.members.find((m) => m.role === "intake")?.status ?? null,
              outboundStatus: loadedGroup?.members.find((m) => m.role === "outbound")?.status ?? null,
              today: romeToday(now),
            })}
          /> : null}

        {group ? (
          <OrderGroupCard
            members={group.members.map((m) => ({
              id: m.id, orderNumber: m.order_number, role: m.role, title: orderTitle(m),
              statusLabel: customerStatusLabel(m.status, m.service_type), totalCents: m.order_charges?.total_cents ?? null,
            }))}
            currentId={o.id}
            hrefOf={(x) => `/cliente/ordini/${x}`}
            note={<>Un solo pagamento per tutta la prenotazione. La fattura è nell&apos;ordine {group.root.order_number}{group.root.id === o.id ? " (questo)" : ""}.</>}
          />
        ) : null}

        <Execution exec={exec} multiLeg={o.order_legs.length > 1} status={o.status} />

        {/* Claims (D138) */}
        {o.claims.some((c) => c.status === "open") ? (
          <Note tone="warning">Hai un reclamo aperto per questo ordine. <Link href="/cliente/reclami" className="font-medium underline">Vedi il reclamo</Link></Note>
        ) : canOpenClaim(o, now) && o.delivered_at ? (
          <Card>
            <H2>Problemi con la consegna?</H2>
            <p className="mt-2 text-sm text-zinc-600">
              Puoi aprire un reclamo fino al {rome(claimDeadline(new Date(o.delivered_at)).toISOString(), { dateStyle: "long" })}.
            </p>
            <Link href={`/cliente/ordini/${o.id}/reclamo`} className="mt-3 inline-block rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50">Apri un reclamo</Link>
            {o.claims.length ? <p className="mt-2 text-xs text-zinc-500"><Link href="/cliente/reclami" className="underline">Reclami precedenti</Link></p> : null}
          </Card>
        ) : o.claims.length ? (
          <p className="text-sm"><Link href="/cliente/reclami" className="font-medium text-brand-700 underline">Reclami di questo ordine</Link></p>
        ) : null}

        {/* Route */}
        {legs.length ? (
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
        ) : null}

        {/* Goods and services */}
        <Card>
          <H2>Merce e servizi</H2>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row k="Merce" v={o.goods_description} />
            {o.shipment_category ? <Row k="Spedizione" v={shipmentText(o.shipment_category, o.stackable) ?? ""} /> : null}
            {o.load_category ? <Row k="Tipo di trasporto" v={PORTER_PACKAGE_LABEL[o.load_category]} /> : null}
            {o.items_count ? <Row k="Colli" v={num.format(o.items_count)} /> : null}
            {o.weight_kg ? <Row k="Peso totale" v={`${num.format(o.weight_kg)} kg`} /> : null}
            {o.largest_item_length_cm && o.largest_item_width_cm && o.largest_item_height_cm ? (
              <Row k="Oggetto più grande" v={`${o.largest_item_length_cm} × ${o.largest_item_width_cm} × ${o.largest_item_height_cm} cm`} />
            ) : null}
            {o.pallets_count ? <Row k={o.shipment_category === "gitterbox" ? "Gitterbox" : "Pallet EUR"} v={String(o.pallets_count)} /> : null}
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

        {/* Invoices (D144–D148) */}
        {invoiceGroups.length ? (
          <Card>
            <H2>Fatture</H2>
            <div className="mt-1"><InvoiceList groups={invoiceGroups} business={business} showOrder={false} /></div>
            <p className="mt-2 text-xs text-zinc-500"><Link href="/cliente/fatture" className="underline">Tutte le fatture</Link></p>
          </Card>
        ) : null}

        {/* Cancellation (D33, D137) */}
        {o.status === "cancelled" && charges ? (
          <Note tone="info">
            Ordine annullato{o.cancelled_at ? ` il ${rome(o.cancelled_at, { dateStyle: "medium", timeStyle: "short" })}` : ""}.
            {charges.cancellation_fee_cents ? <> Costo di annullamento: <strong>{formatCents(charges.cancellation_fee_cents)}</strong>.</> : null}
            {refundTotal > 0 ? (
              <> Rimborso: <strong>{formatCents(refundTotal)}</strong> — {refundPending ? "in elaborazione: arriva sulla carta usata per il pagamento in 5–10 giorni lavorativi." : "inviato sulla carta usata per il pagamento."}</>
            ) : null}
          </Note>
        ) : null}
        {o.status === "cancellation_review" ? (
          <Note tone="warning">Abbiamo ricevuto la tua richiesta di annullamento. Il trasporto era già stato assegnato: il nostro team la valuta e ti contatta per il rimborso.</Note>
        ) : null}
        {paidAndOpen ? (
          <Card>
            <H2>Annullare o modificare l&apos;ordine</H2>
            {cancel ? <div className="mt-3"><CancelPaidOrder orderId={o.id} preview={serializePreview(cancel.preview)} freeHours={cancel.freeHours} feeBp={cancel.feeBp} group={!!group} /></div> : null}
            <p className="mt-3 text-xs text-zinc-500">
              Per modificare l&apos;ordine <Link href="/contatti" className="underline">contattaci</Link> indicando il numero {o.order_number}.
            </p>
          </Card>
        ) : null}

        {/* History */}
        <Card>
          <H2>Cronologia</H2>
          <ol className="mt-3 space-y-2 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex gap-3">
                <span className="w-32 shrink-0 text-zinc-500">{rome(h.created_at, { dateStyle: "short", timeStyle: "short" })}</span>
                <span className="text-zinc-900">
                  {customerStatusLabel(h.to_status, o.service_type)}
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

/** "Prova di consegna" after the delivery; before it only the pickup photos (once loaded) and the porter time. */
function Execution({ exec, multiLeg, status }: { exec: CustomerExecutionView; multiLeg: boolean; status: string }) {
  if (!exec.proof && !exec.photos.length && !exec.porters.length) return null;
  return (
    <Card>
      <H2>{exec.proof ? "Prova di consegna" : "Ritiro della merce"}</H2>
      {exec.proof ? (
        <div className="mt-3 flex flex-wrap items-start gap-4">
          <dl className="grid gap-2 text-sm">
            <Row k="Ricevuto da" v={exec.proof.recipientName} />
            <Row k="Firmato il" v={`${rome(exec.proof.signedAt, { day: "numeric", month: "long", year: "numeric" })}, ${time(exec.proof.signedAt)}`} />
          </dl>
          {exec.proof.signatureUrl ? (
            <figure className="rounded-lg border border-zinc-200 bg-white p-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, no optimizer */}
              <img src={exec.proof.signatureUrl} alt={`Firma di ${exec.proof.recipientName}`} className="h-24 w-auto max-w-full" />
              <figcaption className="mt-1 text-xs text-zinc-500">Firma del destinatario</figcaption>
            </figure>
          ) : (
            <p className="text-sm text-zinc-500">La firma non è visualizzabile in questo momento. Ricarica la pagina.</p>
          )}
        </div>
      ) : null}

      {exec.porters.length ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-zinc-800">Tempo di lavoro dei facchini</h3>
          <ul className="mt-1 space-y-1 text-sm text-zinc-900">
            {exec.porters.map((p) => (
              <li key={p.legIndex}>
                {multiLeg ? (p.legIndex === 0 ? "Ritiro: " : "Consegna: ") : ""}
                <span className="font-medium">{p.workedLabel}</span>
                <span className="text-zinc-600"> ({p.includedLabel} incluse nel prezzo){porterTimeSuffix(p.complete, status)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-zinc-500">Misurato dall&apos;arrivo al termine del carico e dall&apos;arrivo al termine dello scarico, senza il viaggio.</p>
        </div>
      ) : null}

      {groupPhotos(exec.photos).map((g) => (
        <div key={`${g.legIndex}-${g.kind}`} className="mt-4">
          <h3 className="text-sm font-semibold text-zinc-800">
            Foto {PHOTO_KIND_LABEL[g.kind].toLowerCase()}{multiLeg ? (g.legIndex === 0 ? " · tratta verso il deposito" : " · tratta dal deposito") : ""}
          </h3>
          <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {g.photos.map((p) => (
              <li key={p.id}>
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="block aspect-square overflow-hidden rounded-md border border-zinc-200">
                    {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, no optimizer */}
                    <img src={p.url} alt={`Foto ${PHOTO_KIND_LABEL[p.kind].toLowerCase()}, ${time(p.createdAt)}`} className="size-full object-cover" />
                  </a>
                ) : (
                  <span className="flex aspect-square items-center justify-center rounded-md border border-dashed border-zinc-300 p-1 text-center text-xs text-zinc-500">Non disponibile</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {exec.photos.length ? <p className="mt-2 text-xs text-zinc-500">Tocca una foto per aprirla. I link scadono dopo 5 minuti: ricarica la pagina per vederle di nuovo.</p> : null}
    </Card>
  );
}

function PorterJobCard({ job, contact, notes }: { job: PorterJob; contact: string | null; notes: string | null }) {
  return (
    <Card>
      <H2>Facchinaggio</H2>
      <div className="mt-3 rounded-lg bg-zinc-50 p-4">
        <p className="text-sm text-zinc-900">
          {rome(job.window_start, { weekday: "long", day: "numeric", month: "long" })}, {time(job.window_start)}–{time(job.window_end)}
          {job.is_urgent ? <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">Urgente</span> : null}
        </p>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <Place title="Indirizzo" address={job.address} detail={floor(job.floor, job.has_elevator)} />
          <Row k="Facchini" v={`${job.persons} persone, ${job.billed_hours} h${job.billed_hours > job.requested_hours ? " (minimo)" : ""}`} />
        </dl>
      </div>
      <dl className="mt-4 grid gap-3 border-t border-zinc-100 pt-4 text-sm sm:grid-cols-2">
        {contact ? <Row k="Contatto sul posto" v={contact} /> : null}
        {notes ? (
          <div className="sm:col-span-2">
            <dt className="text-zinc-500">Note</dt>
            <dd className="whitespace-pre-line text-zinc-900">{notes}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

function BookingCard({ b, warehouse, phase }: { b: Booking; warehouse: WarehouseInfo | null; phase: BookingPhase }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <H2>Deposito</H2>
        {phase !== "unpaid" ? <BookingPhaseBadge phase={phase} /> : null}
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Row k="Spazio" v={bookingUnitLabel(b)} />
        <Row k="Periodo" v={`${formatDateOnly(b.start_date)} – ${formatDateOnly(b.end_date)} (${bookingDays(b.start_date, b.end_date)} giorni)`} />
        <Row k="Arrivo della merce" v={CUSTOMER_STORAGE_INTAKE_LABEL[b.intake] ?? b.intake} />
        <Row k="Uscita della merce" v={CUSTOMER_STORAGE_OUTBOUND_LABEL[b.outbound] ?? b.outbound} />
        {warehouse ? (
          <div className="sm:col-span-2">
            <dt className="text-zinc-500">Magazzino</dt>
            <dd className="text-zinc-900">{warehouse.name}, {warehouse.address}</dd>
            <dd className="text-xs">
              <a className="text-brand-700 underline" href={`https://www.google.com/maps/search/?api=1&query=${warehouse.lat},${warehouse.lng}`} target="_blank" rel="noopener noreferrer">Apri in Google Maps</a>
            </dd>
          </div>
        ) : null}
      </dl>
    </Card>
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

/** Dates as ISO strings for the client component. */
function serializePreview(p: CancellationPreview) {
  if (p.kind === "review" || p.kind === "not_allowed") return { kind: p.kind };
  return { kind: p.kind, feeCents: p.feeCents, refundCents: p.refundCents, freeUntil: p.freeUntil.toISOString(), basis: p.basis };
}
