import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { CarrierShell } from "@/components/padroncino/carrier-shell";
import { EMPTY_VEHICLE, VehicleForm } from "@/components/padroncino/vehicle-form";
import { requireArea } from "@/lib/auth/session";
import { CARRIER_PATHS, vehicleEditBlock } from "@/lib/carriers/onboarding";
import { loadCarrier, loadVehicleTypes } from "@/lib/carriers/pages";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Nuovo veicolo – Transigo" };

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const ctx = await requireArea("padroncino", CARRIER_PATHS.newVehicle);
  const db = await createClient();
  const [{ view }, types] = await Promise.all([loadCarrier(db, ctx.userId), loadVehicleTypes(db)]);
  const block = vehicleEditBlock(view);

  return (
    <CarrierShell title="Nuovo veicolo" back={{ href: CARRIER_PATHS.vehicles, label: "Veicoli" }}>
      {block ? (
        <p className="rounded-lg bg-zinc-100 p-3 text-sm text-zinc-700">{block}</p>
      ) : (
        <VehicleForm vehicleId={null} initial={EMPTY_VEHICLE} types={types.map((t) => ({ value: t.id, label: t.name_it }))} plateLocked={false} />
      )}
    </CarrierShell>
  );
}
