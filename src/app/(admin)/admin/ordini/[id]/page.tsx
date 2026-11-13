import { Suspense, type ReactNode } from "react";
import { palletsText, shipmentText } from "@/lib/orders/shipment";
import type { ShipmentCategory } from "@/lib/booking/state";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { adminDeps } from "@/lib/admin/deps";
import { ADMIN_CARRIER_PATHS } from "@/lib/carriers/admin";
import { ADMIN_CLAIM_PATHS } from "@/lib/claims/admin";
import { ADMIN_CUSTOMER_PATHS } from "@/lib/customers/admin";
import { CLAIM_CATEGORY_LABEL, CLAIM_STATUS_LABEL, type ClaimCategory } from "@/lib/claims/claims";
import { ADMIN_ORDER_PATHS, HANDOVER_BADGE, handoverKind, isHandoverPending, nextStatusFor, removalOutcome, teamTooSmall, UNASSIGN_REASONS } from "@/lib/orders/dispatch";
import { loadCandidates, loadPorterCandidates, type Candidate, type PortersCandidate } from "@/lib/orders/dispatch-server";
import { loadAdminExecution } from "@/lib/orders/execution-read";
import { orderStatusLabel, PAYMENT_STATE_LABEL, paymentState } from "@/lib/orders/status";
import {
  bookingDays, bookingUnitLabel, formatDateOnly, SERVICE_TYPE_LABEL, serviceTypeOf, STORAGE_BOOKING_STATUS_LABEL, STORAGE_INTAKE_LABEL,
  STORAGE_OUTBOUND_LABEL, type ServiceType,
} from "@/lib/orders/service-type";
import { formatCents } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import { advanceOrderAction, assignHandoverAction, assignJobAction, assignPortersJobAction, unassignJobAction } from "../actions";
import { Execution } from "./execution";
import { OrderGroupCard } from "@/components/orders/order-group-card";
import { orderTitle } from "@/lib/orders/customer-view";
import type { GroupMemberRow } from "@/lib/orders/order-group";
import { loadOrderGroup } from "@/lib/orders/order-group-server";
import { BookingPhaseBadge } from "@/components/orders/booking-phase-badge";
import { bookingPhase, romeToday, type BookingPhase } from "@/lib/orders/booking-phase";
import { Money, type MoneyPayment, type MoneyRefund } from "./money";
import { ADMIN_DOC_COLUMNS, AdminInvoiceTable, type AdminDoc, type DocTech } from "@/components/admin/invoice-table";
import { facchiniLabel, personeLabel } from "@/lib/orders/order-summary";

export const metadata = { title: "Ordine – Transigo" };

// One order for the admin (D122, D123): route, goods, contacts, customer price, carrier amount, payment, history,
// and dispatch — Assegna (candidates by the D120 rules), Rimuovi padroncino (reason code), next status — plus the
// job execution (steps, photos, POD, porter time, "Annulla ultimo passo", "Consenti inizio anticipato", internal notes).
// Facchinaggio and Deposito orders (D151) have no legs: their job / booking replaces "Percorso". Facchinaggio is
// assigned to carriers offering porters, without a vehicle (D164); statuses without "In viaggio" (D165); a team
// that became too small is flagged "Squadra insufficiente" (D167). Deposito is never dispatched to a carrier.
// Reads with the admin's session (RLS; the status history through admin_order_status_history, D128); candidates through the service role after the session check.
export default function Page({ params }: PageProps<"/admin/ordini/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} />
    </Suspense>
  );
}

type Leg = {
  leg_index: number; pickup_address: string; delivery_address: string; pickup_window_start: string; pickup_window_end: string;
  distance_m: number; duration_s: number | null; pickup_floor: number; pickup_has_elevator: boolean; delivery_floor: number;
  delivery_has_elevator: boolean; is_urgent: boolean; porters_count: number; porters_included_hours: number | null;
  pickup_warehouse_id: string | null; delivery_warehouse_id: string | null;
  early_start_allowed_at: string | null; porter_overtime_grace_minutes: number | null;
  order_leg_carrier_terms: { carrier_amount_cents: number } | null;
};
type PorterJob = {
  address: string; city: string; province: string; window_start: string; window_end: string; floor: number; has_elevator: boolean;
  persons: number; requested_hours: number; billed_hours: number; is_urgent: boolean; worked_minutes: number | null;
  order_porter_carrier_terms: { carrier_amount_cents: number } | null;
};
type Booking = {
  unit: string; box_code: string | null; pallets: number | null; start_date: string; end_date: string; payment_plan: string;
  intake: string; outbound: string; status: string; warehouses: { name: string; address: string } | null;
};
type OrderDetail = {
  id: string; order_number: string; service_type: string; status: string; created_at: string; payment_due_at: string; customer_id: string; paid_at: string | null;
  pickup_window_start: string; goods_description: string; items_count: number | null; weight_kg: number | null;
  largest_item_length_cm: number | null; largest_item_width_cm: number | null; largest_item_height_cm: number | null;
  pallets_count: number | null; shipment_category: ShipmentCategory | null; stackable: boolean | null; packing_items_count: number; storage_type: string | null; storage_days: number | null;
  // transport: both contacts; porters: on-site contact in pickup_*; storage: none (orders_service_fields_check)
  pickup_contact_name: string | null; pickup_contact_phone: string | null; delivery_contact_name: string | null; delivery_contact_phone: string | null;
  customer_notes: string | null; carrier_id: string | null; assigned_at: string | null; picked_up_at: string | null;
  in_transit_at: string | null; delivered_at: string | null; delivered_without_pod: boolean;
  handover_required_at: string | null; handover_leg_index: number | null;
  vehicle_types: { name_it: string } | null;
  carriers: { company_name: string; offers_porters: boolean; porters_team_size: number | null } | null;
  carrier_vehicles: { plate: string; vehicle_types: { name_it: string } | null } | null;
  customers: { customer_type: string; profiles: { first_name: string | null; last_name: string | null; email: string; phone: string | null } | null } | null;
  order_legs: Leg[];
  order_porter_jobs: PorterJob | null;
  warehouse_bookings: Booking | null;
  order_charges: { total_cents: number; subtotal_cents: number; vat_cents: number; refunded_cents: number; cancellation_fee_cents: number | null } | null;
  order_lines: { sort_order: number; label_it: string; line_type: string; gross_cents: number }[];
  cancellation_requested_at: string | null; cancellation_reason: string | null;
  payments: MoneyPayment[];
  refunds: MoneyRefund[];
  order_cancellation_decisions: { refund_cents: number; carrier_cents: number; decided_at: string } | null;
  claims: { id: string; status: "open" | "closed"; category: ClaimCategory; created_at: string }[];
};
type HistoryRow = { id: number; from_status: string | null; to_status: string; source: string; changed_by: string | null; created_at: string };

const PAYMENT_COLUMNS = "id, status, amount_cents, amount_received_cents, review_reason, reviewed_at, review_outcome, paid_at, created_at";
const SELECT = [
  "id, order_number, service_type, status, created_at, payment_due_at, customer_id, paid_at, pickup_window_start, goods_description, items_count, weight_kg",
  "largest_item_length_cm, largest_item_width_cm, largest_item_height_cm, pallets_count, shipment_category, stackable, packing_items_count, storage_type, storage_days",
  "pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone, customer_notes",
  "carrier_id, assigned_at, picked_up_at, in_transit_at, delivered_at, delivered_without_pod, handover_required_at, handover_leg_index",
  "vehicle_types(name_it), carriers(company_name, offers_porters, porters_team_size), carrier_vehicles(plate, vehicle_types(name_it))",
  "customers(customer_type, profiles(first_name, last_name, email, phone))",
  "order_legs(leg_index, pickup_address, delivery_address, pickup_window_start, pickup_window_end, distance_m, duration_s, pickup_floor, pickup_has_elevator, delivery_floor, delivery_has_elevator, is_urgent, porters_count, porters_included_hours, pickup_warehouse_id, delivery_warehouse_id, early_start_allowed_at, porter_overtime_grace_minutes, order_leg_carrier_terms(carrier_amount_cents))",
  "order_porter_jobs(address, city, province, window_start, window_end, floor, has_elevator, persons, requested_hours, billed_hours, is_urgent, worked_minutes, order_porter_carrier_terms(carrier_amount_cents))",
  "warehouse_bookings(unit, box_code, pallets, start_date, end_date, payment_plan, intake, outbound, status, warehouses(name, address))",
  "order_charges(total_cents, subtotal_cents, vat_cents, refunded_cents, cancellation_fee_cents)",
  "order_lines(sort_order, label_it, line_type, gross_cents)",
  "cancellation_requested_at, cancellation_reason",
  `payments(${PAYMENT_COLUMNS})`,
  "refunds(id, payment_id, kind, amount_cents, reason, status, stripe_refund_id, retry_of, created_at)",
  "order_cancellation_decisions(refund_cents, carrier_cents, decided_at)",
  "claims(id, status, category, created_at)",
].join(", ");

const SOURCE_LABEL: Record<string, string> = {
  customer_app: "cliente", carrier_app: "padroncino (app)", admin_panel: "admin", stripe_webhook: "Stripe", system_job: "sistema",
};
const rome = (iso: string | null) => (iso ? new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }) : "—");
const time = (iso: string) => new Date(iso).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
const km = (m: number) => `${(m / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })} km`;
const duration = (s: number | null) => {
  if (s == null) return null;
  const min = Math.round(s / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
};
const floor = (n: number, lift: boolean) => (n === 0 ? "piano terra" : `${n}° piano${lift ? ", ascensore" : ", senza ascensore"}`);
const section = "mt-8";
const h2 = "mb-3 text-lg font-semibold text-zinc-900";

async function Content({ params }: Pick<PageProps<"/admin/ordini/[id]">, "params">) {
  const { id } = await params;
  const deps = await adminDeps(ADMIN_ORDER_PATHS.detail(id)); // session check first (DAL)
  if (!z.uuid().safeParse(id).success) notFound();

  const db = await createClient(); // admin's session (RLS)
  const { data: o, error } = await db.from("orders").select(SELECT).eq("id", id).maybeSingle<OrderDetail>();
  if (error) throw new Error(`order unavailable: ${error.code}`);
  if (!o) notFound();

  const type = serviceTypeOf(o.service_type);
  // A storage chain (D153): linked orders; the payment, the invoice and the refunds hang off the first order.
  type GroupRow = GroupMemberRow & {
    status: string; order_charges: { total_cents: number } | null;
    order_legs: { leg_index: number; pickup_city: string; delivery_city: string }[];
    order_porter_jobs: { city: string } | null;
    warehouse_bookings: { unit: string; box_code: string | null; pallets: number | null } | null;
  };
  const loadedGroup = await loadOrderGroup<GroupRow>(db, o.id,
    "status, order_charges(total_cents), order_legs(leg_index, pickup_city, delivery_city), order_porter_jobs(city), warehouse_bookings(unit, box_code, pallets)");
  const group = loadedGroup && loadedGroup.members.length > 1 ? loadedGroup : null;
  let groupMoney: { payments: MoneyPayment[]; group: { rootNumber: string; refundableCents: number } } | null = null;
  if (group) {
    const payments = group.root.id === o.id
      ? o.payments
      : ((await db.from("payments").select(PAYMENT_COLUMNS).eq("order_id", group.root.id)).data ?? []) as MoneyPayment[];
    const main = payments
      .filter((p) => p.status === "succeeded" && (!p.review_reason || p.review_outcome === "accepted"))
      .sort((a, b) => (a.paid_at ?? "").localeCompare(b.paid_at ?? ""))[0];
    let refundableCents = 0;
    if (main) {
      const { data: paymentRefunds } = await db.from("refunds").select("amount_cents, status").eq("payment_id", main.id);
      const active = (rs: { amount_cents: number; status: string }[]) => rs.filter((r) => r.status !== "failed").reduce((s, r) => s + r.amount_cents, 0);
      const paymentLeft = (main.amount_received_cents ?? main.amount_cents) - active(paymentRefunds ?? []);
      const orderLeft = (o.order_charges?.total_cents ?? 0) - active(o.refunds);
      refundableCents = Math.max(0, Math.min(paymentLeft, orderLeft));
    }
    groupMoney = { payments, group: { rootNumber: group.root.order_number, refundableCents } };
  }
  const legs = [...o.order_legs].sort((a, b) => a.leg_index - b.leg_index);
  const lines = [...o.order_lines].sort((a, b) => a.sort_order - b.sort_order);
  // The history with changed_by only through admin_order_status_history (D128: no session reads that column).
  const { data: historyRows, error: historyError } = await db.rpc("admin_order_status_history", { p_order_id: o.id });
  if (historyError) throw new Error(`order history unavailable: ${historyError.code}`);
  const history = [...((historyRows ?? []) as HistoryRow[])].sort((a, b) => a.id - b.id);
  // Carrier terms hang off the legs / the porter job (foreign keys to order_legs / order_porter_jobs, not to orders).
  const carrierAmount = legs.reduce((sum, l) => sum + (l.order_leg_carrier_terms?.carrier_amount_cents ?? 0), 0)
    + (o.order_porter_jobs?.order_porter_carrier_terms?.carrier_amount_cents ?? 0);
  const pay = paymentState({ ...o, refunded_cents: o.order_charges?.refunded_cents, total_cents: o.order_charges?.total_cents }, new Date());
  // Transport: carrier + vehicle (admin_job_candidates); Facchinaggio: carriers offering porters (D164).
  const assignable = type === "transport" && ((o.status === "paid" && !o.carrier_id) || isHandoverPending(o));
  const portersAssignable = type === "porters" && o.status === "paid" && !o.carrier_id;
  const [candidates, porterCandidates, exec, settingsRes, docsRes, techRes] = await Promise.all([
    assignable ? loadCandidates(deps, o.id) : Promise.resolve([] as Candidate[]),
    portersAssignable ? loadPorterCandidates(deps, o.id) : Promise.resolve([] as PortersCandidate[]),
    loadAdminExecution(db, { id: o.id, order_legs: legs }),
    db.from("settings").select("free_cancellation_hours, late_cancellation_fee_bp").single(),
    db.from("invoices").select(ADMIN_DOC_COLUMNS).eq("order_id", o.id).order("created_at").returns<AdminDoc[]>(),
    db.rpc("admin_invoice_errors", { p_order_id: o.id }).returns<DocTech[]>(),
  ]);
  const docTech = new Map(((techRes.data ?? []) as DocTech[]).map((t) => [t.invoice_id, t]));
  if (settingsRes.error || !settingsRes.data) throw new Error(`settings unavailable: ${settingsRes.error?.code}`);

  // Who changed the status, recorded a step or wrote a note (admins and carriers have profiles the admin can read).
  const actorIds = [...new Set([...history.map((h) => h.changed_by), ...exec.actorIds].filter((x): x is string => !!x))];
  const { data: actors } = actorIds.length ? await db.from("profiles").select("id, email, first_name, last_name").in("id", actorIds) : { data: [] };
  const actorName = (uid: string | null) => {
    const a = actors?.find((p) => p.id === uid);
    return a ? [a.first_name, a.last_name].filter(Boolean).join(" ") || a.email : null;
  };
  const customer = o.customers?.profiles;
  const goods = [
    shipmentText(o.shipment_category, o.stackable),
    o.weight_kg ? `${o.weight_kg} kg` : null,
    o.items_count ? `${o.items_count} colli` : null,
    o.largest_item_length_cm ? `oggetto più grande ${o.largest_item_length_cm}×${o.largest_item_width_cm ?? "?"}×${o.largest_item_height_cm ?? "?"} cm` : null,
    o.pallets_count ? palletsText(o.pallets_count, o.shipment_category) : null,
    o.packing_items_count ? `imballaggio ${o.packing_items_count} pezzi` : null,
    o.storage_type ? `deposito ${o.storage_days} giorni` : null,
  ].filter(Boolean).join(" · ");

  return (
    <AdminShell title={`Ordine ${o.order_number}`}>
      <p className="mb-4 text-sm"><Link href={ADMIN_ORDER_PATHS.list} className="text-blue-700 hover:underline">← Ordini</Link></p>

      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-sm ${type === "transport" ? "bg-zinc-100 text-zinc-700" : "bg-violet-100 text-violet-900"}`}>{SERVICE_TYPE_LABEL[type]}</span>
        <span className="rounded bg-zinc-100 px-2 py-0.5 text-sm font-medium text-zinc-900">{orderStatusLabel(o.status, o.service_type)}</span>
        {teamTooSmall(o, o.order_porter_jobs?.persons, o.carriers) ? (
          <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900">Squadra insufficiente: il padroncino non può più coprire {o.order_porter_jobs ? facchiniLabel(o.order_porter_jobs.persons) : "la squadra"}</span>
        ) : null}
        <span className="text-sm text-zinc-600">Pagamento: {PAYMENT_STATE_LABEL[pay]}{o.paid_at ? ` (${rome(o.paid_at)})` : ""}</span>
        {o.delivered_without_pod ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
            {type === "porters" ? "Concluso senza firma del cliente" : "Consegnato senza firma e foto"} — nessun pagamento automatico al padroncino
          </span>
        ) : null}
      </div>

      {o.claims.length ? (
        <ul className="mt-3 space-y-1 text-sm">
          {[...o.claims].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((c) => (
            <li key={c.id} className={`rounded-md px-3 py-2 ${c.status === "open" ? "bg-amber-50 text-amber-950" : "bg-zinc-50 text-zinc-700"}`}>
              Reclamo {CLAIM_STATUS_LABEL[c.status].toLowerCase()}: {CLAIM_CATEGORY_LABEL[c.category]} · {rome(c.created_at)} ·{" "}
              <Link href={ADMIN_CLAIM_PATHS.detail(c.id)} className="text-blue-700 hover:underline">apri</Link>
            </li>
          ))}
        </ul>
      ) : null}

      {type === "porters" ? (
        <PortersDispatch o={o} candidates={porterCandidates} />
      ) : (
        <Dispatch o={o} type={type} legs={legs} steps={exec.steps.map((st) => ({ leg_index: st.legIndex, step: st.step, reverted_at: st.revertedAt }))} candidates={candidates} />
      )}

      <Money d={{
        orderId: o.id, status: o.status, pickupWindowStart: o.pickup_window_start, totalCents: o.order_charges?.total_cents ?? 0,
        cancellationFeeCents: o.order_charges?.cancellation_fee_cents ?? null, cancellationRequestedAt: o.cancellation_requested_at,
        cancellationReason: o.cancellation_reason, carrierAmountCents: carrierAmount, lines: o.order_lines, payments: groupMoney?.payments ?? o.payments,
        group: groupMoney?.group,
        refunds: o.refunds, decision: o.order_cancellation_decisions,
        settings: { freeHours: settingsRes.data.free_cancellation_hours, feeBp: settingsRes.data.late_cancellation_fee_bp },
      }} />

      <section className={section} aria-labelledby="invoices">
        <h2 id="invoices" className={h2}>Fatture</h2>
        {docsRes.error || techRes.error ? <p className="text-sm text-red-700">Errore nel caricamento delle fatture.</p> : null}
        {docsRes.data?.length ? (
          <AdminInvoiceTable docs={docsRes.data} tech={docTech} showOrder={false} />
        ) : (
          <p className="text-sm text-zinc-600">Nessun documento (la fattura viene emessa dopo il pagamento confermato).</p>
        )}
      </section>

      {/* Facchinaggio has no execution steps in the app yet (D165): the admin records the statuses. */}
      {type === "porters" ? null : <Execution orderId={o.id} status={o.status} legs={legs} exec={exec} actorName={actorName} />}

      {o.order_porter_jobs ? <PorterJobSection job={o.order_porter_jobs} /> : null}
      {o.warehouse_bookings ? (
        <BookingSection
          b={o.warehouse_bookings}
          phase={bookingPhase({
            orderStatus: o.status,
            booking: o.warehouse_bookings,
            intakeStatus: loadedGroup?.members.find((m) => m.role === "intake")?.status ?? null,
            outboundStatus: loadedGroup?.members.find((m) => m.role === "outbound")?.status ?? null,
            today: romeToday(new Date()),
          })}
        />
      ) : null}

      {group ? (
        <OrderGroupCard
          heading="Ordini collegati (deposito)"
          members={group.members.map((m) => ({
            id: m.id, orderNumber: m.order_number, role: m.role, title: orderTitle(m),
            statusLabel: orderStatusLabel(m.status, m.service_type), totalCents: m.order_charges?.total_cents ?? null,
          }))}
          currentId={o.id}
          hrefOf={ADMIN_ORDER_PATHS.detail}
          note={
            <>
              Pagamento unico e fattura sull&apos;ordine {group.root.order_number}. I rimborsi si fanno sul singolo ordine (fino al suo importo);
              il cliente annulla solo l&apos;intera prenotazione, finché nessun trasporto è assegnato e il deposito non è iniziato.
            </>
          }
        />
      ) : null}

      {legs.length || type === "transport" ? (
        <section className={section} aria-labelledby="route">
          <h2 id="route" className={h2}>Percorso</h2>
          <ol className="space-y-3">
            {legs.map((l) => (
              <li key={l.leg_index} className="rounded-md border border-zinc-200 p-3 text-sm">
                {legs.length > 1 ? <p className="mb-1 text-xs font-medium uppercase text-zinc-500">Tratta {l.leg_index + 1}</p> : null}
                <p><span className="text-zinc-500">Ritiro:</span> {l.pickup_address} <span className="text-zinc-500">({floor(l.pickup_floor, l.pickup_has_elevator)})</span></p>
                <p><span className="text-zinc-500">Consegna:</span> {l.delivery_address} <span className="text-zinc-500">({floor(l.delivery_floor, l.delivery_has_elevator)})</span></p>
                <p className="mt-1 text-zinc-700">
                  {rome(l.pickup_window_start)}–{time(l.pickup_window_end)} · {km(l.distance_m)}{duration(l.duration_s) ? ` · ${duration(l.duration_s)}` : ""}
                  {l.is_urgent ? " · urgente" : ""}
                  {l.porters_count ? ` · ${facchiniLabel(l.porters_count)}, ${l.porters_included_hours} h` : ""}
                </p>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-sm text-zinc-700"><span className="text-zinc-500">Veicolo richiesto:</span> {o.vehicle_types?.name_it ?? "—"}</p>
        </section>
      ) : null}

      <section className={section} aria-labelledby="goods">
        <h2 id="goods" className={h2}>Merce e contatti</h2>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Row label="Merce"><span className="whitespace-pre-line">{o.goods_description}</span></Row>
          <Row label="Dettagli">{goods || "—"}</Row>
          {o.pickup_contact_name ? (
            <Row label={type === "porters" ? "Contatto sul posto" : "Ritiro"}>{o.pickup_contact_name} · {o.pickup_contact_phone}</Row>
          ) : null}
          {o.delivery_contact_name ? <Row label="Consegna">{o.delivery_contact_name} · {o.delivery_contact_phone}</Row> : null}
          <Row label="Note cliente"><span className="whitespace-pre-line">{o.customer_notes || "—"}</span></Row>
          <Row label="Cliente">
            <Link href={ADMIN_CUSTOMER_PATHS.detail(o.customer_id)} className="text-blue-700 hover:underline">
              {[customer?.first_name, customer?.last_name].filter(Boolean).join(" ") || "—"}
            </Link> · {customer?.email}
            {o.customers?.customer_type === "business" ? " (azienda)" : ""}
          </Row>
        </dl>
      </section>

      <section className={section} aria-labelledby="money">
        <h2 id="money" className={h2}>Importi</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="text-sm">
            <p className="mb-1 font-medium text-zinc-900">Prezzo cliente</p>
            <ul className="space-y-0.5">
              {lines.map((l) => (
                <li key={l.sort_order} className="flex justify-between gap-4"><span>{l.label_it}</span><span>{formatCents(l.gross_cents)}</span></li>
              ))}
            </ul>
            {o.order_charges ? (
              <p className="mt-1 flex justify-between gap-4 border-t border-zinc-200 pt-1 font-medium"><span>Totale (IVA {formatCents(o.order_charges.vat_cents)})</span><span>{formatCents(o.order_charges.total_cents)}</span></p>
            ) : null}
          </div>
          <div className="text-sm">
            <p className="mb-1 font-medium text-zinc-900">Importo padroncino</p>
            <p>{formatCents(carrierAmount)}</p>
          </div>
        </div>
      </section>

      <section className={section} aria-labelledby="history">
        <h2 id="history" className={h2}>Storico stati</h2>
        <ol className="space-y-1 text-sm">
          {history.map((h) => (
            <li key={h.id}>
              <span className="text-zinc-500">{rome(h.created_at)}</span> · {h.from_status ? `${orderStatusLabel(h.from_status, o.service_type)} → ` : ""}
              <span className="font-medium">{orderStatusLabel(h.to_status, o.service_type)}</span>
              <span className="text-zinc-500"> · {SOURCE_LABEL[h.source] ?? h.source}{actorName(h.changed_by) ? ` (${actorName(h.changed_by)})` : ""}</span>
            </li>
          ))}
        </ol>
      </section>
    </AdminShell>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-zinc-500">{label}:</dt>
      <dd className="text-zinc-900">{children}</dd>
    </div>
  );
}

function PorterJobSection({ job }: { job: PorterJob }) {
  return (
    <section className={section} aria-labelledby="porters">
      <h2 id="porters" className={h2}>Facchinaggio</h2>
      <div className="rounded-md border border-zinc-200 p-3 text-sm">
        <p><span className="text-zinc-500">Indirizzo:</span> {job.address} <span className="text-zinc-500">({floor(job.floor, job.has_elevator)})</span></p>
        <p className="mt-1 text-zinc-700">
          {rome(job.window_start)}–{time(job.window_end)}{job.is_urgent ? " · urgente" : ""}
          {` · ${facchiniLabel(job.persons)}, ${job.billed_hours} h`}
          {job.billed_hours > job.requested_hours ? ` (richieste ${job.requested_hours} h, minimo del listino)` : ""}
        </p>
        {job.worked_minutes != null ? <p className="mt-1 text-zinc-700">Tempo lavorato: {Math.floor(job.worked_minutes / 60)} h {job.worked_minutes % 60} min</p> : null}
      </div>
    </section>
  );
}

function BookingSection({ b, phase }: { b: Booking; phase: BookingPhase }) {
  return (
    <section className={section} aria-labelledby="storage">
      <h2 id="storage" className={h2}>Deposito</h2>
      <dl className="grid gap-x-6 gap-y-1 rounded-md border border-zinc-200 p-3 text-sm sm:grid-cols-2">
        <Row label="Magazzino">{b.warehouses?.name ?? "—"}</Row>
        <Row label="Spazio">{bookingUnitLabel(b)}</Row>
        <Row label="Periodo">{formatDateOnly(b.start_date)} – {formatDateOnly(b.end_date)} ({bookingDays(b.start_date, b.end_date)} giorni)</Row>
        <Row label="Stato">
          <BookingPhaseBadge phase={phase} />
          {/* Nothing records the arrival / exit yet: the phase comes from the dates and the chain's transports. */}
          {b.status === "booked" && phase !== "booked" && phase !== "unpaid" ? <span className="ml-2 text-xs text-zinc-500">dalle date e dai trasporti (prenotazione: {STORAGE_BOOKING_STATUS_LABEL[b.status]})</span> : null}
          {phase === "ended" ? <span className="mt-1 block text-xs text-amber-800">Periodo pagato terminato: verifica il ritiro o una proroga.</span> : null}
        </Row>
        <Row label="Arrivo merce">{STORAGE_INTAKE_LABEL[b.intake] ?? b.intake}</Row>
        <Row label="Uscita merce">{STORAGE_OUTBOUND_LABEL[b.outbound] ?? b.outbound}</Row>
        <Row label="Pagamento">{b.payment_plan === "monthly" ? "Mensile" : "Tutto subito"}</Row>
      </dl>
    </section>
  );
}

type StepRef = { leg_index: number; step: string; reverted_at: string | null };
type LegRef = OrderDetail["order_legs"][number];

function Dispatch({ o, type, legs, steps, candidates }: { o: OrderDetail; type: ServiceType; legs: LegRef[]; steps: StepRef[]; candidates: Candidate[] }) {
  const next = nextStatusFor(o.status, type);
  // Deposito is never dispatched to a carrier (D152); Facchinaggio has its own section (PortersDispatch).
  if (type !== "transport") return null;
  const windowPassed = new Date(o.pickup_window_start) <= new Date();
  // from leg 1 "Carico completato" (status picked_up) on, release_job refuses — only the admin removes the carrier;
  // the order then never goes back to the list (D130, D136): "da gestire", or refused when everything is unloaded
  const loaded = o.status === "picked_up" || o.status === "in_transit";
  const outcome = removalOutcome(o.status, legs, steps);

  if (o.status === "paid" && !o.carrier_id) {
    return (
      <section className={section} aria-labelledby="dispatch">
        <h2 id="dispatch" className={h2}>Assegna padroncino</h2>
        {candidates.length ? (
          <ActionForm action={assignJobAction} submitLabel="Assegna" className="max-w-xl rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="orderId" value={o.id} />
            <label htmlFor="candidate" className="block text-sm font-medium text-zinc-800">Padroncino e veicolo</label>
            <select id="candidate" name="candidate" required defaultValue="" className={`${inputClass} mt-1 w-full`}>
              <option value="" disabled>Scegli…</option>
              {candidates.map((c) => (
                <option key={c.vehicle_id} value={`${c.carrier_id}:${c.vehicle_id}`}>
                  {c.company_name} — {c.plate} ({c.vehicle_type_name}{c.payload_kg ? `, ${c.payload_kg} kg` : ""})
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-zinc-500">Solo padroncini attivi con documenti approvati e un veicolo adatto all&apos;ordine.</p>
          </ActionForm>
        ) : (
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
            {windowPassed
              ? "La finestra di ritiro è già iniziata: l'ordine non si può assegnare. Serve un cambio data o un rimborso."
              : "Nessun padroncino attivo ha un veicolo adatto e pronto per questo ordine."}
          </p>
        )}
      </section>
    );
  }

  if (isHandoverPending(o)) return <Handover o={o} legs={legs} steps={steps} candidates={candidates} />;

  if (!o.carrier_id) return null;
  return (
    <section className={section} aria-labelledby="dispatch">
      <h2 id="dispatch" className={h2}>Padroncino</h2>
      <p className="text-sm">
        {o.carriers?.company_name ?? "—"}
        {o.carrier_vehicles ? ` · ${o.carrier_vehicles.plate} (${o.carrier_vehicles.vehicle_types?.name_it ?? "—"})` : ""}
        {" · "}<Link href={ADMIN_CARRIER_PATHS.detail(o.carrier_id)} className="text-blue-700 hover:underline">scheda padroncino</Link>
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        Assegnato {rome(o.assigned_at)} · ritirato {rome(o.picked_up_at)} · in viaggio {rome(o.in_transit_at)} · consegnato {rome(o.delivered_at)}
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {next ? (
          <ActionForm action={advanceOrderAction} submitLabel={next.label} className="rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="orderId" value={o.id} />
            <input type="hidden" name="to" value={next.to} />
            {next.to === "delivered" ? (
              <>
                <p className="text-sm text-amber-900">Senza firma e foto del destinatario: il pagamento al padroncino non partirà in automatico.</p>
                <label htmlFor="note" className="mt-2 block text-sm font-medium text-zinc-800">Motivo (obbligatorio)</label>
                <textarea id="note" name="note" required maxLength={1000} rows={2} className={`${inputClass} mt-1 w-full`} />
                <p className="mt-1 text-xs text-zinc-500">Il motivo è interno: lo vedono solo gli amministratori.</p>
              </>
            ) : (
              <p className="text-sm text-zinc-700">Stato successivo: {orderStatusLabel(next.to, o.service_type)}.</p>
            )}
          </ActionForm>
        ) : null}
        {o.status === "assigned" || loaded ? (
          <ActionForm action={unassignJobAction} submitLabel="Rimuovi padroncino" variant="danger" className="rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="orderId" value={o.id} />
            <label htmlFor="reason" className="block text-sm font-medium text-zinc-800">Motivo</label>
            <select id="reason" name="reason" required defaultValue="" className={`${inputClass} mt-1 w-full`}>
              <option value="" disabled>Scegli…</option>
              {UNASSIGN_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
            {outcome === "in_warehouse" ? (
              <p className="mt-1 text-sm font-medium text-red-800">
                La merce è in magazzino: l&apos;ordine passa in «Da gestire». Il cliente continua a vedere «{orderStatusLabel(o.status, o.service_type)}»;
                dovrai assegnare tu un nuovo padroncino per la tratta successiva (ritiro in magazzino).
              </p>
            ) : outcome === "all_unloaded" ? (
              <p className="mt-1 text-sm font-medium text-amber-900">
                La merce è già stata scaricata a destinazione: il padroncino non si può rimuovere. Usa «Segna come consegnato» con il motivo.
              </p>
            ) : loaded || outcome === "on_board" ? (
              <p className="mt-1 text-sm font-medium text-red-800">
                Attenzione: il carico è già a bordo del padroncino. Dopo la rimozione l&apos;ordine diventa «da gestire»: non torna tra le corse
                disponibili e dovrai assegnarlo tu a un padroncino (con l&apos;indirizzo dove si trova la merce) o chiuderlo come consegnato.
              </p>
            ) : windowPassed ? (
              <p className="mt-1 text-xs text-amber-900">La finestra di ritiro è già iniziata: dopo la rimozione l&apos;ordine non sarà assegnabile (serve un cambio data o un rimborso).</p>
            ) : <p className="mt-1 text-xs text-zinc-500">L&apos;ordine tornerà tra quelli da assegnare.</p>}
          </ActionForm>
        ) : null}
      </div>
    </section>
  );
}

/** "Da gestire": the admin removed the carrier with the load on board — assign directly or close without POD. */
function Handover({ o, legs, steps, candidates }: { o: OrderDetail; legs: LegRef[]; steps: StepRef[]; candidates: Candidate[] }) {
  const next = nextStatusFor(o.status, o.service_type);
  const kind = handoverKind(o, steps);
  // goods in the warehouse: the leg to take over starts there — its pickup address, editable (D136)
  const warehouseAddress = kind === "in_warehouse" ? (legs.find((l) => l.leg_index === o.handover_leg_index)?.pickup_address ?? "") : "";
  return (
    <section className={section} aria-labelledby="handover">
      <h2 id="handover" className={h2}>Da gestire</h2>
      <p className="rounded-md bg-red-50 p-3 text-sm font-medium text-red-900">
        {HANDOVER_BADGE[kind]}
        {o.handover_leg_index !== null && o.order_legs.length > 1 ? ` (tratta ${o.handover_leg_index + 1})` : ""} — dal {rome(o.handover_required_at)}.
        <span className="mt-1 block font-normal">L&apos;ordine non è visibile ai padroncini. Il cliente vede ancora «{orderStatusLabel(o.status, o.service_type)}».</span>
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {candidates.length ? (
          <ActionForm action={assignHandoverAction} submitLabel="Assegna padroncino" className="rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="orderId" value={o.id} />
            <label htmlFor="handover-candidate" className="block text-sm font-medium text-zinc-800">Padroncino e veicolo</label>
            <select id="handover-candidate" name="candidate" required defaultValue="" className={`${inputClass} mt-1 w-full`}>
              <option value="" disabled>Scegli…</option>
              {candidates.map((c) => (
                <option key={c.vehicle_id} value={`${c.carrier_id}:${c.vehicle_id}`}>
                  {c.company_name} — {c.plate} ({c.vehicle_type_name}{c.payload_kg ? `, ${c.payload_kg} kg` : ""})
                </option>
              ))}
            </select>
            <label htmlFor="handover-address" className="mt-2 block text-sm font-medium text-zinc-800">Dove si trova ora la merce (obbligatorio)</label>
            <textarea id="handover-address" name="address" required maxLength={500} rows={2} defaultValue={warehouseAddress} className={`${inputClass} mt-1 w-full`} />
            <p className="mt-1 text-xs text-zinc-500">Lo vede solo il nuovo padroncino (non il cliente): ritirerà la merce qui.</p>
            <label htmlFor="handover-reason" className="mt-2 block text-sm font-medium text-zinc-800">Motivo (obbligatorio)</label>
            <textarea id="handover-reason" name="reason" required maxLength={1000} rows={2} className={`${inputClass} mt-1 w-full`} />
            <p className="mt-1 text-xs text-zinc-500">Il motivo è interno: lo vedono solo gli amministratori.</p>
          </ActionForm>
        ) : (
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">Nessun padroncino attivo ha un veicolo adatto e pronto per questo ordine.</p>
        )}
        {next ? (
          <ActionForm action={advanceOrderAction} submitLabel={next.label} className="rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="orderId" value={o.id} />
            <input type="hidden" name="to" value={next.to} />
            {next.to === "delivered" ? (
              <>
                <p className="text-sm text-amber-900">Senza firma e foto del destinatario: nessun pagamento automatico.</p>
                <label htmlFor="handover-note" className="mt-2 block text-sm font-medium text-zinc-800">Motivo (obbligatorio)</label>
                <textarea id="handover-note" name="note" required maxLength={1000} rows={2} className={`${inputClass} mt-1 w-full`} />
                <p className="mt-1 text-xs text-zinc-500">Il motivo è interno: lo vedono solo gli amministratori.</p>
              </>
            ) : (
              <p className="text-sm text-zinc-700">Stato successivo: {orderStatusLabel(next.to, o.service_type)}.</p>
            )}
          </ActionForm>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Facchinaggio (D164–D167): "Assegna facchini" among carriers offering porters with a big enough team (no vehicle);
 * then "Segna lavoro iniziato" → "Segna lavoro concluso" (reason required: without POD, D123). "Rimuovi padroncino"
 * only before the work started (admin_unassign_job refuses after: work_started).
 */
function PortersDispatch({ o, candidates }: { o: OrderDetail; candidates: PortersCandidate[] }) {
  const job = o.order_porter_jobs;
  const next = nextStatusFor(o.status, "porters");
  if (o.status === "paid" && !o.carrier_id) {
    const started = new Date(o.pickup_window_start) <= new Date();
    return (
      <section className={section} aria-labelledby="dispatch">
        <h2 id="dispatch" className={h2}>Assegna facchini</h2>
        {candidates.length ? (
          <ActionForm action={assignPortersJobAction} submitLabel="Assegna" className="max-w-xl rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="orderId" value={o.id} />
            <label htmlFor="porters-carrier" className="block text-sm font-medium text-zinc-800">Padroncino</label>
            <select id="porters-carrier" name="carrierId" required defaultValue="" className={`${inputClass} mt-1 w-full`}>
              <option value="" disabled>Scegli…</option>
              {candidates.map((c) => (
                <option key={c.carrier_id} value={c.carrier_id}>{c.company_name} — squadra di {c.porters_team_size}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-zinc-500">Solo padroncini attivi con documenti approvati che offrono il facchinaggio con almeno {job ? personeLabel(job.persons) : "? persone"}. Nessun veicolo richiesto.</p>
          </ActionForm>
        ) : (
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
            {started
              ? "Il lavoro doveva già iniziare: l'ordine non si può assegnare. Serve un cambio data o un rimborso."
              : `Nessun padroncino attivo offre il facchinaggio con una squadra di almeno ${job?.persons ?? "?"} persone.`}
          </p>
        )}
      </section>
    );
  }
  if (!o.carrier_id) return null;
  return (
    <section className={section} aria-labelledby="dispatch">
      <h2 id="dispatch" className={h2}>Facchini</h2>
      <p className="text-sm">
        {o.carriers?.company_name ?? "—"}
        {o.carriers?.offers_porters ? ` · squadra di ${o.carriers.porters_team_size}` : " · non offre più il facchinaggio"}
        {" · "}<Link href={ADMIN_CARRIER_PATHS.detail(o.carrier_id)} className="text-blue-700 hover:underline">scheda padroncino</Link>
      </p>
      <p className="mt-1 text-xs text-zinc-500">Assegnato {rome(o.assigned_at)} · lavoro iniziato {rome(o.picked_up_at)} · lavoro concluso {rome(o.delivered_at)}</p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {next ? (
          <ActionForm action={advanceOrderAction} submitLabel={next.label} className="rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="orderId" value={o.id} />
            <input type="hidden" name="to" value={next.to} />
            {next.to === "delivered" ? (
              <>
                <p className="text-sm text-amber-900">Senza firma del cliente dall&apos;app: il pagamento al padroncino non partirà in automatico.</p>
                <label htmlFor="porters-note" className="mt-2 block text-sm font-medium text-zinc-800">Motivo (obbligatorio)</label>
                <textarea id="porters-note" name="note" required maxLength={1000} rows={2} className={`${inputClass} mt-1 w-full`} />
                <p className="mt-1 text-xs text-zinc-500">Il motivo è interno: lo vedono solo gli amministratori.</p>
              </>
            ) : (
              <p className="text-sm text-zinc-700">Stato successivo: {orderStatusLabel(next.to, "porters")}.</p>
            )}
          </ActionForm>
        ) : null}
        {o.status === "assigned" ? (
          <ActionForm action={unassignJobAction} submitLabel="Rimuovi padroncino" variant="danger" className="rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="orderId" value={o.id} />
            <label htmlFor="porters-reason" className="block text-sm font-medium text-zinc-800">Motivo</label>
            <select id="porters-reason" name="reason" required defaultValue="" className={`${inputClass} mt-1 w-full`}>
              <option value="" disabled>Scegli…</option>
              {UNASSIGN_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
            <p className="mt-1 text-xs text-zinc-500">L&apos;ordine tornerà tra quelli da assegnare.</p>
          </ActionForm>
        ) : o.status === "picked_up" ? (
          <p className="rounded-md bg-zinc-50 p-3 text-sm text-zinc-700">Il lavoro è già iniziato: il padroncino non si può più rimuovere.</p>
        ) : null}
      </div>
    </section>
  );
}
