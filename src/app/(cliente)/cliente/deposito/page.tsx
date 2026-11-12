import { Suspense } from "react";
import Link from "next/link";
import { Card, CustomerShell, StatusBadge } from "@/components/cliente/customer-shell";
import { Loading } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";
import { STORAGE_PHASE_LABEL, STORAGE_VISIBLE_STATUSES, storageView, type StorageLeg, type StorageStep } from "@/lib/orders/storage-view";
import { createClient } from "@/lib/supabase/server";
import { BookingPhaseBadge } from "@/components/orders/booking-phase-badge";
import { isOpenBookingPhase, romeToday } from "@/lib/orders/booking-phase";
import { loadStorageBookings } from "@/lib/orders/order-group-server";
import type { BookingEntry, GroupOrderRow, StorageOrderRow } from "@/lib/orders/storage-bookings";
import { bookingDays, bookingUnitLabel, CUSTOMER_STORAGE_INTAKE_LABEL, CUSTOMER_STORAGE_OUTBOUND_LABEL, formatDateOnly } from "@/lib/orders/service-type";

export const metadata = { title: "Deposito – Transigo" };

// "Deposito" (spec 7, D139): the customer's storage bookings (Deposito wizard, D153) with the phase from
// booking-phase.ts, then the older orders with storage legs (model A, demo data) — where the goods are. Read-only,
// with the customer's own session (steps with an explicit column list). "Prolunga" online — step 10; until then
// "contattaci".
export default function Page() {
  return (
    <CustomerShell title="Deposito" subtitle="La merce che hai affidato al nostro magazzino.">
      <Suspense fallback={<Loading />}>
        <Content />
      </Suspense>
    </CustomerShell>
  );
}

type Row = {
  id: string; order_number: string; status: string; storage_days: number | null; storage_pallets: number | null;
  // Steps hang off the legs (FK order_leg_steps → order_legs), not off the order.
  order_legs: (StorageLeg & { delivery_address: string; delivery_city: string; pickup_city: string; order_leg_steps: StorageStep[] })[];
};

const day = (iso: string) => new Date(iso).toLocaleDateString("it-IT", { timeZone: "Europe/Rome", weekday: "short", day: "numeric", month: "long", year: "numeric" });
const dayTime = (iso: string) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

async function Content() {
  await requireArea("cliente", "/cliente/deposito");
  const supabase = await createClient();
  const bookings = await loadStorageBookings<StorageOrderRow>(supabase, "status, warehouse_bookings(unit, box_code, pallets, start_date, end_date, intake, outbound, status)", romeToday(new Date()))
    .then((rows) => rows.filter((e) => e.phase !== "unpaid" && e.phase !== "cancelled"))
    .catch(() => null);
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, status, storage_days, storage_pallets, order_legs(leg_index, pickup_window_start, delivery_address, delivery_city, pickup_city, order_leg_steps(leg_index, step, created_at, reverted_at))")
    .not("storage_type", "is", null)
    .in("status", [...STORAGE_VISIBLE_STATUSES])
    .order("pickup_window_start", { ascending: false })
    .returns<Row[]>();
  if (error || !bookings) return <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">Non è stato possibile caricare il deposito. Riprova tra qualche istante.</p>;

  const rows = (data ?? []).map((o) => ({ o, v: storageView({ ...o, order_leg_steps: o.order_legs.flatMap((l) => l.order_leg_steps) }) }));
  const current = rows.filter((r) => r.v.phase === "incoming" || r.v.phase === "stored");
  const past = rows.filter((r) => r.v.phase === "left" || r.v.phase === "delivered");

  if (!rows.length && !bookings.length) {
    return (
      <Card>
        <p className="text-sm text-zinc-600">Non hai merce in deposito.</p>
        <Link href="/prenota/deposito" className="mt-3 inline-block rounded-md bg-brand-800 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-900">Prenota un deposito</Link>
      </Card>
    );
  }
  const openBookings = bookings.filter((e) => isOpenBookingPhase(e.phase));
  const pastBookings = bookings.filter((e) => !isOpenBookingPhase(e.phase));

  return (
    <div className="space-y-6">
      {bookings.length ? (
        <>
          <BookingSection title="In corso" entries={openBookings} empty="Nessun deposito in corso." />
          {pastBookings.length ? <BookingSection title="Conclusi" entries={pastBookings} empty="" /> : null}
        </>
      ) : null}
      {rows.length ? (
        <>
          <Section title={bookings.length ? "Trasporti con deposito" : "In corso"} rows={current} empty="Nessuna merce in magazzino in questo momento." />
          {past.length ? <Section title={bookings.length ? "Trasporti con deposito conclusi" : "Conclusi"} rows={past} empty="" /> : null}
        </>
      ) : null}
      <p className="text-sm text-zinc-600">
        Vuoi prolungare il deposito? <Link href="/contatti" className="font-medium underline">Contattaci</Link> prima della data di ritiro indicando il numero dell&apos;ordine.
      </p>
    </div>
  );
}

function Section({ title, rows, empty }: { title: string; rows: { o: Row; v: ReturnType<typeof storageView> }[]; empty: string }) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-zinc-900">{title}</h2>
      {!rows.length ? <p className="text-sm text-zinc-500">{empty}</p> : null}
      <div className="space-y-3">
        {rows.map(({ o, v }) => {
          const leg0 = o.order_legs.find((l) => l.leg_index === 0);
          const leg1 = o.order_legs.find((l) => l.leg_index === 1);
          return (
            <Card key={o.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-zinc-900">{STORAGE_PHASE_LABEL[v.phase]}</p>
                  <p className="text-sm text-zinc-500">
                    <Link href={`/cliente/ordini/${o.id}`} className="underline">Ordine {o.order_number}</Link>
                    {leg0 && leg1 ? <> · {leg0.pickup_city} → magazzino → {leg1.delivery_city}</> : null}
                  </p>
                </div>
                <StatusBadge status={o.status} />
              </div>
              <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {leg0 ? <Item k="Magazzino" v={leg0.delivery_address} /> : null}
                {o.storage_pallets ? <Item k="Pallet" v={String(o.storage_pallets)} /> : null}
                {v.storedAt ? <Item k="Entrata in magazzino" v={dayTime(v.storedAt)} /> : v.plannedEntry ? <Item k="Entrata prevista" v={day(v.plannedEntry)} /> : null}
                {v.paidUntil ? <Item k="Pagato fino al" v={`${day(v.paidUntil)}${o.storage_days ? ` (${o.storage_days} ${o.storage_days === 1 ? "giorno" : "giorni"})` : ""}`} /> : null}
                {v.leftAt ? <Item k="Uscita dal magazzino" v={dayTime(v.leftAt)} /> : null}
              </dl>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

type BookingRow = StorageOrderRow & { status: string };

function BookingSection({ title, entries, empty }: { title: string; entries: BookingEntry<BookingRow, GroupOrderRow>[]; empty: string }) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-zinc-900">{title}</h2>
      {!entries.length ? <p className="text-sm text-zinc-500">{empty}</p> : null}
      <div className="space-y-3">
        {entries.map(({ order: o, booking: b, phase, members }) => (
          <Card key={o.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-zinc-900">{bookingUnitLabel(b)}</p>
                <p className="text-sm text-zinc-500">
                  <Link href={`/cliente/ordini/${o.id}`} className="underline">Ordine {o.order_number}</Link>
                  {members.length > 1 ? <> · con {members.flatMap((m) => (m.role === "intake" ? ["ritiro"] : m.role === "outbound" ? ["consegna"] : [])).join(" e ")} Transigo</> : null}
                </p>
              </div>
              <BookingPhaseBadge phase={phase} />
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Item k="Periodo" v={`${formatDateOnly(b.start_date)} – ${formatDateOnly(b.end_date)} (${bookingDays(b.start_date, b.end_date)} giorni)`} />
              <Item k="Arrivo della merce" v={CUSTOMER_STORAGE_INTAKE_LABEL[b.intake] ?? b.intake} />
              <Item k="Uscita della merce" v={CUSTOMER_STORAGE_OUTBOUND_LABEL[b.outbound] ?? b.outbound} />
            </dl>
            {phase === "ended" ? <p className="mt-3 text-sm text-amber-800">Il periodo pagato è terminato. Se la merce è ancora in magazzino, contattaci.</p> : null}
          </Card>
        ))}
      </div>
    </section>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-zinc-500">{k}</dt>
      <dd className="text-zinc-900">{v}</dd>
    </div>
  );
}
