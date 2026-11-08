import Link from "next/link";
import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatCents } from "@/lib/pricing/money";
import { createVehicleAction, updateVehicleAction } from "./actions";

export const metadata = { title: "Veicoli – Transigo" };

type Vehicle = {
  id?: string; code: string; name_it: string; payload_kg: number | null; cargo_length_cm: number | null; cargo_width_cm: number | null;
  cargo_height_cm: number | null; cargo_volume_dm3: number | null; size_rank: number; sort_order: number; is_active: boolean;
};

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  await requireArea("admin", "/admin/veicoli");
  const db = await createClient();
  const [{ data: vehicles }, { data: active }] = await Promise.all([
    db.from("vehicle_types").select("*").order("size_rank"),
    db.from("price_lists").select("id, version, price_list_vehicle_rates(vehicle_type_id, rate_per_km_cents, min_price_cents)").eq("status", "active").maybeSingle(),
  ]);
  const rates = new Map((active?.price_list_vehicle_rates ?? []).map((r: { vehicle_type_id: string; rate_per_km_cents: number; min_price_cents: number }) => [r.vehicle_type_id, r]));
  const nextRank = Math.max(0, ...(vehicles ?? []).map((v) => v.size_rank)) + 1;

  return (
    <AdminShell title="Tipi di veicolo">
      <p className="mb-4 text-sm">
        La <strong>classe di grandezza</strong> (1 = più piccolo) decide quali corse vede un padroncino: quelle per il suo veicolo e per i veicoli più piccoli.
        Tariffa €/km e prezzo minimo si modificano nel <Link href="/admin/listini" className="text-blue-700 hover:underline">listino</Link>
        {active ? ` (attivo: v${active.version})` : ""}.
      </p>
      <div className="space-y-4">
        {(vehicles ?? []).map((v) => {
          const r = rates.get(v.id);
          return (
            <div key={v.id} className="rounded-md border border-zinc-200 p-3">
              <p className="mb-2 text-sm">
                <strong>{v.name_it}</strong> ·{" "}
                {r ? `${formatCents(r.rate_per_km_cents)}/km, minimo ${formatCents(r.min_price_cents)}` : <span className="text-red-700">nessuna tariffa nel listino attivo</span>}
              </p>
              <ActionForm action={updateVehicleAction} submitLabel="Salva">
                <input type="hidden" name="id" value={v.id} />
                <VehicleFields v={v} />
              </ActionForm>
            </div>
          );
        })}
        <div className="rounded-md border border-dashed border-zinc-300 p-3">
          <p className="mb-2 text-sm font-semibold">Nuovo tipo di veicolo</p>
          <ActionForm action={createVehicleAction} submitLabel="Aggiungi">
            <VehicleFields v={{ code: "", name_it: "", payload_kg: null, cargo_length_cm: null, cargo_width_cm: null, cargo_height_cm: null, cargo_volume_dm3: null, size_rank: nextRank, sort_order: nextRank * 10, is_active: false }} />
          </ActionForm>
        </div>
      </div>
    </AdminShell>
  );
}

function VehicleFields({ v }: { v: Vehicle }) {
  const n = (x: number | null) => (x == null ? "" : String(x));
  return (
    <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
      <label className="flex flex-col gap-1">Codice<input name="code" defaultValue={v.code} className={inputClass} /></label>
      <label className="col-span-1 flex flex-col gap-1 sm:col-span-2">Nome<input name="name_it" defaultValue={v.name_it} className={inputClass} /></label>
      <label className="flex flex-col gap-1">Classe di grandezza<input name="size_rank" defaultValue={v.size_rank} className={inputClass} /></label>
      <label className="flex flex-col gap-1">Ordine<input name="sort_order" defaultValue={v.sort_order} className={inputClass} /></label>
      <label className="flex flex-col gap-1">Portata (kg)<input name="payload_kg" defaultValue={n(v.payload_kg)} className={inputClass} /></label>
      <label className="flex flex-col gap-1">Lunghezza (cm)<input name="cargo_length_cm" defaultValue={n(v.cargo_length_cm)} className={inputClass} /></label>
      <label className="flex flex-col gap-1">Larghezza (cm)<input name="cargo_width_cm" defaultValue={n(v.cargo_width_cm)} className={inputClass} /></label>
      <label className="flex flex-col gap-1">Altezza (cm)<input name="cargo_height_cm" defaultValue={n(v.cargo_height_cm)} className={inputClass} /></label>
      <label className="flex flex-col gap-1">Volume (dm³)<input name="cargo_volume_dm3" defaultValue={n(v.cargo_volume_dm3)} className={inputClass} /></label>
      <label className="flex items-center gap-2"><input type="checkbox" name="is_active" defaultChecked={v.is_active} /> Attivo</label>
    </div>
  );
}
