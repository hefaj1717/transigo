import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { updateAreaSettingsAction, updateRegionAction } from "./actions";

export const metadata = { title: "Area di servizio – Transigo" };

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  await requireArea("admin", "/admin/area-di-servizio");
  const db = await createClient();
  const [{ data: provinces }, { data: settings }] = await Promise.all([
    db.from("service_area_provinces").select("province_code, name_it, region_it, is_active").order("region_it").order("name_it"),
    db.from("settings").select("max_route_distance_m, min_booking_lead_hours, quote_valid_minutes").single(),
  ]);
  const regions = new Map<string, NonNullable<typeof provinces>>();
  for (const p of provinces ?? []) regions.set(p.region_it, [...(regions.get(p.region_it) ?? []), p]);
  const activeCount = (provinces ?? []).filter((p) => p.is_active).length;

  return (
    <AdminShell title="Area di servizio">
      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Regole</h2>
        <p className="mb-3 text-sm">
          L&apos;indirizzo di <strong>ritiro</strong> deve essere in una provincia attiva; la consegna può essere ovunque in Italia se il percorso non supera la distanza massima.
        </p>
        <ActionForm action={updateAreaSettingsAction} submitLabel="Salva">
          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <label className="flex flex-col gap-1">Distanza massima del percorso (km)
              <input name="max_km" defaultValue={settings ? Math.round(settings.max_route_distance_m / 1000) : ""} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">Preavviso minimo di prenotazione (ore)
              <input name="min_booking_lead_hours" defaultValue={settings?.min_booking_lead_hours ?? ""} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">Validità del preventivo (minuti)
              <input name="quote_valid_minutes" defaultValue={settings?.quote_valid_minutes ?? ""} className={inputClass} />
            </label>
          </div>
        </ActionForm>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Province di ritiro servite ({activeCount})</h2>
        {activeCount === 0 ? <p className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">Nessuna provincia attiva: il preventivatore mostrerà “Al momento non serviamo questa zona” per ogni indirizzo.</p> : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[...regions.entries()].map(([region, list]) => (
            <div key={region} className="rounded-md border border-zinc-200 p-3">
              <ActionForm action={updateRegionAction} submitLabel={`Salva ${region}`} variant="secondary">
                <input type="hidden" name="region" value={region} />
                <p className="mb-1 text-sm font-semibold">{region}</p>
                <div className="grid grid-cols-2 gap-1 text-sm">
                  {list.map((p) => (
                    <label key={p.province_code} className="flex items-center gap-2">
                      <input type="hidden" name="province" value={p.province_code} />
                      <input type="checkbox" name="active" value={p.province_code} defaultChecked={p.is_active} />
                      {p.name_it} ({p.province_code})
                    </label>
                  ))}
                </div>
              </ActionForm>
            </div>
          ))}
        </div>
      </section>
    </AdminShell>
  );
}
