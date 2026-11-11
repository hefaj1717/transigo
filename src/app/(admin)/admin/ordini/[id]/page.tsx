import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { adminDeps } from "@/lib/admin/deps";
import { ADMIN_CARRIER_PATHS } from "@/lib/carriers/admin";
import { ADMIN_ORDER_PATHS, NEXT_STATUS, UNASSIGN_REASONS } from "@/lib/orders/dispatch";
import { loadCandidates, type Candidate } from "@/lib/orders/dispatch-server";
import { ORDER_STATUS_LABEL, PAYMENT_STATE_LABEL, paymentState } from "@/lib/orders/status";
import { formatCents } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import { advanceOrderAction, assignJobAction, unassignJobAction } from "../actions";

export const metadata = { title: "Ordine – Transigo" };

// One order for the admin (D122, D123): route, goods, contacts, customer price, carrier amount, payment, history,
// and dispatch — Assegna (candidates by the D120 rules), Rimuovi padroncino (reason code), next status.
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
  order_leg_carrier_terms: { carrier_amount_cents: number } | null;
};
type OrderDetail = {
  id: string; order_number: string; status: string; created_at: string; payment_due_at: string; paid_at: string | null;
  pickup_window_start: string; goods_description: string; items_count: number | null; weight_kg: number | null;
  largest_item_length_cm: number | null; largest_item_width_cm: number | null; largest_item_height_cm: number | null;
  pallets_count: number | null; packing_items_count: number; storage_type: string | null; storage_days: number | null;
  pickup_contact_name: string; pickup_contact_phone: string; delivery_contact_name: string; delivery_contact_phone: string;
  customer_notes: string | null; carrier_id: string | null; assigned_at: string | null; picked_up_at: string | null;
  in_transit_at: string | null; delivered_at: string | null; delivered_without_pod: boolean;
  vehicle_types: { name_it: string } | null;
  carriers: { company_name: string } | null;
  carrier_vehicles: { plate: string; vehicle_types: { name_it: string } | null } | null;
  customers: { customer_type: string; profiles: { first_name: string | null; last_name: string | null; email: string; phone: string | null } | null } | null;
  order_legs: Leg[];
  order_charges: { total_cents: number; subtotal_cents: number; vat_cents: number; refunded_cents: number } | null;
  order_lines: { sort_order: number; label_it: string; gross_cents: number }[];
};
type HistoryRow = { id: number; from_status: string | null; to_status: string; source: string; changed_by: string | null; created_at: string };

const SELECT = [
  "id, order_number, status, created_at, payment_due_at, paid_at, pickup_window_start, goods_description, items_count, weight_kg",
  "largest_item_length_cm, largest_item_width_cm, largest_item_height_cm, pallets_count, packing_items_count, storage_type, storage_days",
  "pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone, customer_notes",
  "carrier_id, assigned_at, picked_up_at, in_transit_at, delivered_at, delivered_without_pod",
  "vehicle_types(name_it), carriers(company_name), carrier_vehicles(plate, vehicle_types(name_it))",
  "customers(customer_type, profiles(first_name, last_name, email, phone))",
  "order_legs(leg_index, pickup_address, delivery_address, pickup_window_start, pickup_window_end, distance_m, duration_s, pickup_floor, pickup_has_elevator, delivery_floor, delivery_has_elevator, is_urgent, porters_count, porters_included_hours, pickup_warehouse_id, delivery_warehouse_id, order_leg_carrier_terms(carrier_amount_cents))",
  "order_charges(total_cents, subtotal_cents, vat_cents, refunded_cents)",
  "order_lines(sort_order, label_it, gross_cents)",
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

  const legs = [...o.order_legs].sort((a, b) => a.leg_index - b.leg_index);
  const lines = [...o.order_lines].sort((a, b) => a.sort_order - b.sort_order);
  // The history with changed_by only through admin_order_status_history (D128: no session reads that column).
  const { data: historyRows, error: historyError } = await db.rpc("admin_order_status_history", { p_order_id: o.id });
  if (historyError) throw new Error(`order history unavailable: ${historyError.code}`);
  const history = [...((historyRows ?? []) as HistoryRow[])].sort((a, b) => a.id - b.id);
  // Carrier terms hang off the legs (foreign key to order_legs, not to orders).
  const carrierAmount = legs.reduce((sum, l) => sum + (l.order_leg_carrier_terms?.carrier_amount_cents ?? 0), 0);
  const pay = paymentState({ ...o, refunded_cents: o.order_charges?.refunded_cents, total_cents: o.order_charges?.total_cents }, new Date());
  const assignable = o.status === "paid" && !o.carrier_id;
  const candidates = assignable ? await loadCandidates(deps, o.id) : [];

  // Who changed the status (admins and carriers have profiles the admin can read).
  const actorIds = [...new Set(history.map((h) => h.changed_by).filter((x): x is string => !!x))];
  const { data: actors } = actorIds.length ? await db.from("profiles").select("id, email, first_name, last_name").in("id", actorIds) : { data: [] };
  const actorName = (uid: string | null) => {
    const a = actors?.find((p) => p.id === uid);
    return a ? [a.first_name, a.last_name].filter(Boolean).join(" ") || a.email : null;
  };
  const customer = o.customers?.profiles;
  const goods = [
    o.weight_kg ? `${o.weight_kg} kg` : null,
    o.items_count ? `${o.items_count} colli` : null,
    o.largest_item_length_cm ? `oggetto più grande ${o.largest_item_length_cm}×${o.largest_item_width_cm ?? "?"}×${o.largest_item_height_cm ?? "?"} cm` : null,
    o.pallets_count ? `${o.pallets_count} pallet` : null,
    o.packing_items_count ? `imballaggio ${o.packing_items_count} pezzi` : null,
    o.storage_type ? `deposito ${o.storage_days} giorni` : null,
  ].filter(Boolean).join(" · ");

  return (
    <AdminShell title={`Ordine ${o.order_number}`}>
      <p className="mb-4 text-sm"><Link href={ADMIN_ORDER_PATHS.list} className="text-blue-700 hover:underline">← Ordini</Link></p>

      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-zinc-100 px-2 py-0.5 text-sm font-medium text-zinc-900">{ORDER_STATUS_LABEL[o.status] ?? o.status}</span>
        <span className="text-sm text-zinc-600">Pagamento: {PAYMENT_STATE_LABEL[pay]}{o.paid_at ? ` (${rome(o.paid_at)})` : ""}</span>
        {o.delivered_without_pod ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Consegnato senza firma e foto — nessun pagamento automatico al padroncino</span>
        ) : null}
      </div>

      <Dispatch o={o} candidates={candidates} />

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
                {l.porters_count ? ` · ${l.porters_count} facchini, ${l.porters_included_hours} h` : ""}
              </p>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-sm text-zinc-700"><span className="text-zinc-500">Veicolo richiesto:</span> {o.vehicle_types?.name_it ?? "—"}</p>
      </section>

      <section className={section} aria-labelledby="goods">
        <h2 id="goods" className={h2}>Merce e contatti</h2>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Row label="Merce"><span className="whitespace-pre-line">{o.goods_description}</span></Row>
          <Row label="Dettagli">{goods || "—"}</Row>
          <Row label="Ritiro">{o.pickup_contact_name} · {o.pickup_contact_phone}</Row>
          <Row label="Consegna">{o.delivery_contact_name} · {o.delivery_contact_phone}</Row>
          <Row label="Note cliente"><span className="whitespace-pre-line">{o.customer_notes || "—"}</span></Row>
          <Row label="Cliente">
            {[customer?.first_name, customer?.last_name].filter(Boolean).join(" ") || "—"} · {customer?.email}
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
              <span className="text-zinc-500">{rome(h.created_at)}</span> · {h.from_status ? `${ORDER_STATUS_LABEL[h.from_status] ?? h.from_status} → ` : ""}
              <span className="font-medium">{ORDER_STATUS_LABEL[h.to_status] ?? h.to_status}</span>
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

function Dispatch({ o, candidates }: { o: OrderDetail; candidates: Candidate[] }) {
  const next = NEXT_STATUS[o.status];
  const windowPassed = new Date(o.pickup_window_start) <= new Date();
  // the load is on board from leg 1 "Carico completato" (status picked_up) on — release_job refuses, only the admin removes
  const loaded = o.status === "picked_up" || o.status === "in_transit";

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
              <p className="text-sm text-zinc-700">Stato successivo: {ORDER_STATUS_LABEL[next.to]}.</p>
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
            {loaded ? (
              <p className="mt-1 text-sm font-medium text-red-800">
                Attenzione: il carico è già a bordo del padroncino. Dopo la rimozione l&apos;ordine torna «da assegnare»; organizza tu il recupero della merce.
              </p>
            ) : null}
            {windowPassed ? (
              <p className="mt-1 text-xs text-amber-900">La finestra di ritiro è già iniziata: dopo la rimozione l&apos;ordine non sarà assegnabile (serve un cambio data o un rimborso).</p>
            ) : <p className="mt-1 text-xs text-zinc-500">L&apos;ordine tornerà tra quelli da assegnare.</p>}
          </ActionForm>
        ) : null}
      </div>
    </section>
  );
}
