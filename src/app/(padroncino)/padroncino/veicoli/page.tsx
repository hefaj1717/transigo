import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { bigButton, CarrierShell } from "@/components/padroncino/carrier-shell";
import { requireArea } from "@/lib/auth/session";
import { canEditVehicles, CARRIER_PATHS, vehicleEditBlock } from "@/lib/carriers/onboarding";
import { loadCarrier, loadVehicles, loadVehicleTypes } from "@/lib/carriers/pages";
import { createClient } from "@/lib/supabase/server";
import { VehicleBadge } from "./vehicle-badge";

export const metadata = { title: "Veicoli – Transigo" };

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const ctx = await requireArea("padroncino", CARRIER_PATHS.vehicles);
  const db = await createClient();
  const [{ view }, vehicles, types] = await Promise.all([loadCarrier(db, ctx.userId), loadVehicles(db, ctx.userId), loadVehicleTypes(db)]);
  const typeName = new Map(types.map((t) => [t.id, t.name_it]));
  const block = vehicleEditBlock(view);

  return (
    <CarrierShell title="Veicoli" back={{ href: CARRIER_PATHS.home, label: "Indietro" }}>
      {block ? <p className="mb-4 rounded-lg bg-zinc-100 p-3 text-sm text-zinc-700">{block}</p> : null}
      {vehicles.length === 0 ? (
        <p className="text-sm text-zinc-600">Non hai ancora aggiunto veicoli. Serve almeno un veicolo attivo, con libretto e assicurazione RCA.</p>
      ) : (
        <ul className="space-y-3">
          {vehicles.map((v) => (
            <li key={v.id}>
              <Link href={CARRIER_PATHS.vehicle(v.id)} className="block rounded-xl border border-zinc-200 bg-white p-4 active:bg-zinc-50">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-lg font-semibold tracking-wide text-zinc-900">{v.plate}</span>
                  <VehicleBadge vehicle={v} />
                </div>
                <p className="mt-1 text-sm text-zinc-600">
                  {typeName.get(v.vehicle_type_id) ?? "Tipo non più disponibile"} · portata {v.payload_kg.toLocaleString("it-IT")} kg
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {canEditVehicles(view) ? (
        <Link href={CARRIER_PATHS.newVehicle} className={`${bigButton} mt-6`}>Aggiungi veicolo</Link>
      ) : null}
    </CarrierShell>
  );
}
