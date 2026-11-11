import { Suspense } from "react";
import Link from "next/link";
import { Card, CustomerShell, StatusBadge } from "@/components/cliente/customer-shell";
import { Loading } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";
import { STORAGE_PHASE_LABEL, STORAGE_VISIBLE_STATUSES, storageView, type StorageLeg, type StorageStep } from "@/lib/orders/storage-view";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Deposito – Transigo" };

// "Deposito" (spec 7, D139): orders with storage — where the goods are, pallets, paid until. Read-only, with the
// customer's own session (steps with an explicit column list). Extending the storage online (D9) comes with model B
// (D117) — until then "contattaci".
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
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, status, storage_days, storage_pallets, order_legs(leg_index, pickup_window_start, delivery_address, delivery_city, pickup_city, order_leg_steps(leg_index, step, created_at, reverted_at))")
    .not("storage_type", "is", null)
    .in("status", [...STORAGE_VISIBLE_STATUSES])
    .order("pickup_window_start", { ascending: false })
    .returns<Row[]>();
  if (error) return <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">Non è stato possibile caricare il deposito. Riprova tra qualche istante.</p>;

  const rows = (data ?? []).map((o) => ({ o, v: storageView({ ...o, order_leg_steps: o.order_legs.flatMap((l) => l.order_leg_steps) }) }));
  const current = rows.filter((r) => r.v.phase === "incoming" || r.v.phase === "stored");
  const past = rows.filter((r) => r.v.phase === "left" || r.v.phase === "delivered");

  if (!rows.length) {
    return (
      <Card>
        <p className="text-sm text-zinc-600">Non hai merce in deposito. Puoi aggiungere il deposito quando prenoti un trasporto, nel passo «Servizi extra».</p>
        <Link href="/prenota" className="mt-3 inline-block rounded-md bg-brand-800 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-900">Prenota</Link>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Section title="In corso" rows={current} empty="Nessuna merce in magazzino in questo momento." />
      {past.length ? <Section title="Conclusi" rows={past} empty="" /> : null}
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

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-zinc-500">{k}</dt>
      <dd className="text-zinc-900">{v}</dd>
    </div>
  );
}
