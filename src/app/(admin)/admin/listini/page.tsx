import Link from "next/link";
import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { cloneListAction } from "./actions";

export const metadata = { title: "Listini – Transigo" };

const STATUS = { draft: "Bozza", active: "Attivo", archived: "Archiviato" } as const;

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  await requireArea("admin", "/admin/listini");
  const db = await createClient();
  const { data: lists } = await db.from("price_lists").select("id, version, status, notes, published_at, created_at").order("version", { ascending: false });

  return (
    <AdminShell title="Listini prezzi">
      <p className="mb-4 text-sm">
        Un listino pubblicato non si modifica: crea una bozza (copia), modificala e pubblicala. La pubblicazione archivia il listino attivo.
      </p>
      <table className="w-full text-sm">
        <thead className="text-left text-zinc-500">
          <tr><th className="py-1">Versione</th><th>Stato</th><th>Pubblicato</th><th>Note</th><th /></tr>
        </thead>
        <tbody>
          {(lists ?? []).map((l) => (
            <tr key={l.id} className="border-t border-zinc-100 align-top">
              <td className="py-2"><Link href={`/admin/listini/${l.id}`} className="text-blue-700 hover:underline">v{l.version}</Link></td>
              <td className={l.status === "active" ? "font-semibold text-green-700" : ""}>{STATUS[l.status as keyof typeof STATUS]}</td>
              <td>{l.published_at ? new Date(l.published_at).toLocaleString("it-IT", { timeZone: "Europe/Rome" }) : "—"}</td>
              <td className="max-w-xs">{l.notes ?? ""}</td>
              <td>
                <ActionForm action={cloneListAction} submitLabel="Crea bozza da questa versione" variant="secondary">
                  <input type="hidden" name="id" value={l.id} />
                </ActionForm>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </AdminShell>
  );
}
