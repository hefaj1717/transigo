import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { addHolidayAction, deleteHolidayAction } from "./actions";

export const metadata = { title: "Festività – Transigo" };

const WEEKDAY = new Intl.DateTimeFormat("it-IT", { weekday: "long", timeZone: "UTC" });

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  await requireArea("admin", "/admin/festivita");
  const db = await createClient();
  const { data: holidays } = await db.from("holidays").select("date, name_it").order("date");
  const byYear = new Map<string, { date: string; name_it: string }[]>();
  for (const h of holidays ?? []) byYear.set(h.date.slice(0, 4), [...(byYear.get(h.date.slice(0, 4)) ?? []), h]);
  const lastYear = [...byYear.keys()].pop();

  return (
    <AdminShell title="Festività nazionali">
      <p className="mb-4 text-sm">
        Un ritiro di sabato, domenica o in una di queste date ha il supplemento weekend/festivo (una sola volta). Solo festività nazionali, senza santi patroni.
        {lastYear ? ` Le date arrivano fino al ${lastYear}: aggiungi l'anno successivo in tempo (Pasqua e Pasquetta cambiano ogni anno).` : ""}
      </p>
      <section className="mb-6 rounded-md border border-dashed border-zinc-300 p-3">
        <ActionForm action={addHolidayAction} submitLabel="Aggiungi">
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex flex-col gap-1">Data<input type="date" name="date" className={inputClass} /></label>
            <label className="flex flex-col gap-1">Nome<input name="name_it" className={inputClass} /></label>
          </div>
        </ActionForm>
      </section>
      {[...byYear.entries()].map(([year, list]) => (
        <section key={year} className="mb-6">
          <h2 className="mb-2 text-lg font-semibold">{year}</h2>
          <table className="w-full text-sm">
            <tbody>
              {list.map((h) => (
                <tr key={h.date} className="border-t border-zinc-100">
                  <td className="py-1">{new Date(`${h.date}T00:00:00Z`).toLocaleDateString("it-IT", { timeZone: "UTC" })}</td>
                  <td className="text-zinc-500">{WEEKDAY.format(new Date(`${h.date}T00:00:00Z`))}</td>
                  <td>{h.name_it}</td>
                  <td>
                    <ActionForm action={deleteHolidayAction} submitLabel="Elimina" variant="secondary">
                      <input type="hidden" name="date" value={h.date} />
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </AdminShell>
  );
}
