import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Loading } from "@/components/panel-shell";
import { CarrierShell } from "@/components/padroncino/carrier-shell";
import { VehicleActiveToggle, VehicleForm } from "@/components/padroncino/vehicle-form";
import { requireArea } from "@/lib/auth/session";
import { CARRIER_PATHS, vehicleEditBlock } from "@/lib/carriers/onboarding";
import { loadCarrier, loadVehicle, loadVehicleTypes } from "@/lib/carriers/pages";
import { createClient } from "@/lib/supabase/server";
import { VehicleBadge } from "../vehicle-badge";

export const metadata = { title: "Veicolo – Transigo" };

export default function Page({ params, searchParams }: PageProps<"/padroncino/veicoli/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ params, searchParams }: Pick<PageProps<"/padroncino/veicoli/[id]">, "params" | "searchParams">) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requireArea("padroncino", CARRIER_PATHS.vehicle(id));
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const db = await createClient();
  const [{ view }, vehicle, types] = await Promise.all([loadCarrier(db, ctx.userId), loadVehicle(db, ctx.userId, id), loadVehicleTypes(db)]);
  if (!vehicle) notFound();

  const options = types.map((t) => ({ value: t.id, label: t.name_it }));
  if (!options.some((o) => o.value === vehicle.vehicle_type_id)) {
    options.unshift({ value: vehicle.vehicle_type_id, label: "Tipo non più disponibile" });
  }
  const typeLabel = options.find((o) => o.value === vehicle.vehicle_type_id)?.label ?? "—";
  const block = vehicleEditBlock(view);
  const s = (n: number | null) => (n == null ? "" : String(n));

  return (
    <CarrierShell title={vehicle.plate} back={{ href: CARRIER_PATHS.vehicles, label: "Veicoli" }}>
      <div className="mb-4"><VehicleBadge vehicle={vehicle} /></div>
      {sp.nuovo === "1" ? (
        <p role="status" className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-800">
          Veicolo aggiunto. Ora carica il libretto di circolazione e l&apos;assicurazione RCA di questo veicolo.
        </p>
      ) : null}

      {block ? (
        <>
          <p className="rounded-lg bg-zinc-100 p-3 text-sm text-zinc-700">{block}</p>
          <dl className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
            {[
              ["Tipo di veicolo", typeLabel],
              ["Portata", `${vehicle.payload_kg.toLocaleString("it-IT")} kg`],
              ["Vano di carico", vehicle.cargo_length_cm ? `${vehicle.cargo_length_cm} × ${vehicle.cargo_width_cm ?? "—"} × ${vehicle.cargo_height_cm ?? "—"} cm` : "—"],
            ].map(([label, value]) => (
              <div key={label} className="px-4 py-3">
                <dt className="text-xs text-zinc-500">{label}</dt>
                <dd className="mt-0.5 text-zinc-900">{value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <div className="space-y-8">
          <VehicleForm
            vehicleId={vehicle.id}
            initial={{
              vehicleTypeId: vehicle.vehicle_type_id, plate: vehicle.plate, payloadKg: s(vehicle.payload_kg),
              cargoLengthCm: s(vehicle.cargo_length_cm), cargoWidthCm: s(vehicle.cargo_width_cm), cargoHeightCm: s(vehicle.cargo_height_cm),
            }}
            types={options}
            plateLocked={!!vehicle.first_approved_at}
          />
          <VehicleActiveToggle vehicleId={vehicle.id} isActive={vehicle.is_active} />
        </div>
      )}
    </CarrierShell>
  );
}
