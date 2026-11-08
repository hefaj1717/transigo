import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { saveWarehouseAction } from "./actions";
import { PlaceInput } from "./place-input";

export const metadata = { title: "Magazzino – Transigo" };

// D72: warehouse address used by the booking wizard for storage orders (legs A→warehouse, warehouse→B).
export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  await requireArea("admin", "/admin/magazzino");
  const db = await createClient();
  const { data: warehouses } = await db.from("warehouses").select("id, name, address, province, is_active").order("created_at");
  const active = (warehouses ?? []).find((w) => w.is_active);

  return (
    <AdminShell title="Magazzino">
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
