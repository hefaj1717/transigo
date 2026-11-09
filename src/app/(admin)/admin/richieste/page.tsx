import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { AdminShell } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { ADMIN_CONTACT_PATHS } from "@/lib/contact/server";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Richieste – Transigo" };

// Contact requests (D125): "Nuove" / "Gestite". Read with the admin's session (RLS: admins only).
export default function Page({ searchParams }: PageProps<"/admin/richieste">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

const TABS = [
  { key: "nuove", label: "Nuove", status: "new" },
  { key: "gestite", label: "Gestite", status: "handled" },
] as const;

const KIND_LABEL: Record<string, string> = { general: "Contatti", out_of_area: "Zona non servita" };

type Row = { id: string; kind: string; name: string; email: string; message: string; created_at: string; handled_at: string | null; pickup_province: string | null };

const rome = (iso: string) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" });

async function Content({ searchParams }: Pick<PageProps<"/admin/richieste">, "searchParams">) {
  await requireArea("admin", ADMIN_CONTACT_PATHS.list);
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.stato) ?? TABS[0];

  const db = await createClient();
  const { data, error } = await db
    .from("contact_requests")
    .select("id, kind, name, email, message, created_at, handled_at, pickup_province")
    .eq("status", tab.status)
    .order(tab.status === "new" ? "created_at" : "handled_at", { ascending: tab.status === "new" })
    .limit(200)
    .returns<Row[]>();

  return (
    <AdminShell title="Richieste">
      <nav className="mb-4 flex flex-wrap gap-2 text-sm">
        {TABS.map((t) => (
          <Link key={t.key} href={t.key === "nuove" ? ADMIN_CONTACT_PATHS.list : `${ADMIN_CONTACT_PATHS.list}?stato=${t.key}`} className={`rounded-full px-3 py-1 ${t.key === tab.key ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      {error ? <p className="text-sm text-red-700">Errore nel caricamento delle richieste.</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-2 pr-3 font-medium">Ricevuta</th>
              <th className="py-2 pr-3 font-medium">Tipo</th>
              <th className="py-2 pr-3 font-medium">Mittente</th>
              <th className="py-2 font-medium">Messaggio</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 align-top">
                <td className="py-2 pr-3 whitespace-nowrap">
                  <Link href={ADMIN_CONTACT_PATHS.detail(r.id)} className="text-blue-700 hover:underline">{rome(r.created_at)}</Link>
                </td>
                <td className="py-2 pr-3">
                  {KIND_LABEL[r.kind] ?? r.kind}
                  {r.pickup_province ? <div className="text-xs text-zinc-500">Ritiro: {r.pickup_province}</div> : null}
                </td>
                <td className="py-2 pr-3">
                  {r.name}
                  <div className="text-xs text-zinc-500">{r.email}</div>
                </td>
                <td className="py-2 text-zinc-600">{r.message.length > 120 ? `${r.message.slice(0, 120)}…` : r.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && !data.length ? <p className="mt-4 text-sm text-zinc-600">Nessuna richiesta.</p> : null}
      <p className="mt-6 text-xs text-zinc-500">Le richieste gestite vengono cancellate automaticamente 24 mesi dopo la gestione.</p>
    </AdminShell>
  );
}
