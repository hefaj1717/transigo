import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { customerDisplayName } from "@/lib/customers/admin";
import { ADMIN_ORDER_PATHS } from "@/lib/orders/dispatch";
import { adminStorageNumbers, STORAGE_PHASE_LABEL, STORAGE_VISIBLE_STATUSES, storageView, type StorageLeg, type StoragePhase, type StorageStep } from "@/lib/orders/storage-view";
import { createClient } from "@/lib/supabase/server";
import { saveWarehouseAction } from "./actions";
import { PlaceInput } from "./place-input";

export const metadata = { title: "Magazzino – Transigo" };

// "Magazzino" (spec 9, D9, D72): the goods of the orders with storage (model A, D117 — phase from the carrier's
// steps, as the customer's "Deposito"), then the warehouse used by the booking wizard. Read with the admin's
// session (RLS). Receiving / releasing = the carrier's steps; payment link for an extension and the location in the
// warehouse — later, with model B (D143).
export default function Page({ searchParams }: PageProps<"/admin/magazzino">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

const GOODS_TABS: { key: string; label: string; phases: StoragePhase[] }[] = [
  { key: "in-magazzino", label: "In magazzino", phases: ["stored"] },
  { key: "in-arrivo", label: "In arrivo", phases: ["incoming"] },
  { key: "usciti", label: "Usciti", phases: ["left", "delivered"] },
];

type GoodsRow = {
  id: string; order_number: string; status: string; storage_days: number | null; storage_pallets: number | null; handover_required_at: string | null;
  carriers: { company_name: string } | null;
  customers: { customer_type: string; company_name: string | null; profiles: { first_name: string | null; last_name: string | null; email: string } | null } | null;
  order_legs: (StorageLeg & { order_leg_steps: StorageStep[] })[];
};

const rome = (iso: string | null) => (iso ? new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }) : "—");

async function Goods({ tabKey }: { tabKey: unknown }) {
  await connection();
  const tab = GOODS_TABS.find((t) => t.key === tabKey) ?? GOODS_TABS[0];
  const db = await createClient();
  const { data, error } = await db
    .from("orders")
    .select("id, order_number, status, storage_days, storage_pallets, handover_required_at, carriers(company_name), customers(customer_type, company_name, profiles(first_name, last_name, email)), order_legs(leg_index, pickup_window_start, order_leg_steps(leg_index, step, created_at, reverted_at))")
    .not("storage_type", "is", null)
    .in("status", [...STORAGE_VISIBLE_STATUSES])
    .order("pickup_window_start", { ascending: true })
    .limit(300)
    .returns<GoodsRow[]>();
  const now = new Date();
  const all = (data ?? []).map((o) => {
    const v = storageView({ ...o, order_leg_steps: o.order_legs.flatMap((l) => l.order_leg_steps) });
    return { o, v, n: adminStorageNumbers(v, now) };
  });
  const count = (t: (typeof GOODS_TABS)[number]) => all.filter((r) => t.phases.includes(r.v.phase)).length;
  const rows = all.filter((r) => tab.phases.includes(r.v.phase));
  if (tab.key === "usciti") rows.sort((a, b) => (b.v.leftAt ?? b.v.paidUntil ?? "").localeCompare(a.v.leftAt ?? a.v.paidUntil ?? ""));
  const pallets = all.filter((r) => r.v.phase === "stored").reduce((s, r) => s + (r.o.storage_pallets ?? 0), 0);

  return (
    <section className="mb-10" aria-labelledby="goods">
      <h2 id="goods" className="mb-1 text-lg font-semibold text-zinc-900">Merce in deposito</h2>
      <p className="mb-3 text-sm text-zinc-600">Ora in magazzino: {count(GOODS_TABS[0])} ordini, {pallets} pallet. Entrata e uscita = passi del padroncino (scarico tratta 1, carico tratta 2).</p>
      <nav className="mb-3 flex flex-wrap gap-2 text-sm">
        {GOODS_TABS.map((t) => (
          <Link key={t.key} href={t.key === GOODS_TABS[0].key ? "/admin/magazzino" : `/admin/magazzino?merce=${t.key}`} className={`rounded-full px-3 py-1 ${t.key === tab.key ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"}`}>
            {t.label} ({count(t)})
          </Link>
        ))}
      </nav>
      {error ? <p className="text-sm text-red-700">Errore nel caricamento della merce.</p> : null}
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="py-2 pr-3 font-medium">Ordine</th>
                <th className="py-2 pr-3 font-medium">Cliente</th>
                <th className="py-2 pr-3 font-medium">Pallet</th>
                <th className="py-2 pr-3 font-medium">Entrata</th>
                <th className="py-2 pr-3 font-medium">Pagato fino a</th>
                <th className="py-2 pr-3 font-medium">Giorni</th>
                <th className="py-2 font-medium">Padroncino</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ o, v, n }) => {
                const c = o.customers;
                return (
                  <tr key={o.id} className="border-t border-zinc-100 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <Link href={ADMIN_ORDER_PATHS.detail(o.id)} className="text-blue-700 hover:underline">{o.order_number}</Link>
                      <div className="text-xs text-zinc-500">{STORAGE_PHASE_LABEL[v.phase]}</div>
                      {o.handover_required_at ? <div className="text-xs font-medium text-red-800">Da gestire</div> : null}
                    </td>
                    <td className="py-2 pr-3">{c?.profiles ? customerDisplayName({ ...c, first_name: c.profiles.first_name, last_name: c.profiles.last_name, email: c.profiles.email }) : "—"}</td>
                    <td className="py-2 pr-3">{o.storage_pallets ?? "—"}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{v.storedAt ? rome(v.storedAt) : <span className="text-zinc-500">prevista {rome(v.plannedEntry)}</span>}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {rome(v.paidUntil)}
                      {n.overdue ? <div className="text-xs font-medium text-red-800">Periodo pagato scaduto</div> : null}
                      {v.leftAt ? <div className="text-xs text-zinc-500">uscito {rome(v.leftAt)}</div> : null}
                    </td>
                    <td className="py-2 pr-3">{n.daysStored ?? "—"}{o.storage_days != null ? <span className="text-zinc-500"> / {o.storage_days} pagati</span> : null}</td>
                    <td className="py-2">{o.carriers?.company_name ?? <span className="text-zinc-500">da assegnare</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="text-sm text-zinc-600">Nessun ordine.</p>}
      <p className="mt-2 text-xs text-zinc-500">Proroga con link di pagamento e posizione in magazzino: con il modello a tratte separate (D117). Per ora si gestisce contattando il cliente.</p>
    </section>
  );
}

async function Content({ searchParams }: Pick<PageProps<"/admin/magazzino">, "searchParams">) {
  await requireArea("admin", "/admin/magazzino");
  const sp = await searchParams;
  const db = await createClient();
  const { data: warehouses } = await db.from("warehouses").select("id, name, address, province, is_active").order("created_at");
  const active = (warehouses ?? []).find((w) => w.is_active);

  return (
    <AdminShell title="Magazzino">
      <Goods tabKey={sp.merce} />
      <h2 className="mb-1 text-lg font-semibold text-zinc-900">Magazzini</h2>
      <p className="mb-4 text-sm">
        Il deposito nel preventivatore usa il magazzino <strong>attivo</strong> (nel MVP uno solo). La sua provincia deve essere attiva in “Area di servizio”.
      </p>
      {!active ? <p className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">Nessun magazzino attivo: il deposito non è prenotabile.</p> : null}

      {(warehouses ?? []).map((w) => (
        <section key={w.id} className="mb-6 rounded-md border border-zinc-200 p-4">
          <ActionForm action={saveWarehouseAction} submitLabel="Salva">
            <input type="hidden" name="id" value={w.id} />
            <p className="mb-2 text-sm text-zinc-600">{w.address} ({w.province})</p>
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <label className="flex flex-col gap-1">Nome
                <input name="name" defaultValue={w.name} className={inputClass} />
              </label>
              <label className="flex items-center gap-2 pt-5">
                <input type="checkbox" name="is_active" defaultChecked={w.is_active} /> Attivo
              </label>
            </div>
            <div className="mt-3 text-sm">
              <PlaceInput id={`addr-${w.id}`} label="Nuovo indirizzo (lascia vuoto per non cambiarlo)" />
            </div>
          </ActionForm>
        </section>
      ))}

      <section className="rounded-md border border-dashed border-zinc-300 p-4">
        <h2 className="mb-2 text-lg font-semibold">Aggiungi magazzino</h2>
        <ActionForm action={saveWarehouseAction} submitLabel="Aggiungi">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <label className="flex flex-col gap-1">Nome
              <input name="name" className={inputClass} placeholder="Es. Magazzino Milano" />
            </label>
            <label className="flex items-center gap-2 pt-5">
              <input type="checkbox" name="is_active" defaultChecked={!active} /> Attivo
            </label>
          </div>
          <div className="mt-3 text-sm">
            <PlaceInput id="addr-new" label="Indirizzo" />
          </div>
        </ActionForm>
      </section>
    </AdminShell>
  );
}
