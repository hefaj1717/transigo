import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { Loading } from "@/components/panel-shell";
import { AdminShell } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { ADMIN_CLAIM_PATHS, ADMIN_CLAIM_TABS, claimAgeLabel, parseAdminClaimTab } from "@/lib/claims/admin";
import { CLAIM_CATEGORY_LABEL, type ClaimCategory } from "@/lib/claims/claims";
import { ADMIN_ORDER_PATHS } from "@/lib/orders/dispatch";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Reclami – Transigo" };

// Claims (spec 9, D138): "Aperti" (oldest first) / "Chiusi". Read with the admin's session (RLS: admins read all).
export default function Page({ searchParams }: PageProps<"/admin/reclami">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

type Row = {
  id: string; order_id: string; category: ClaimCategory; description: string; created_at: string; closed_at: string | null;
  orders: { order_number: string; customers: { profiles: { first_name: string | null; last_name: string | null; email: string } | null } | null } | null;
  claim_photos: { count: number }[];
};

const rome = (iso: string) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" });

async function Content({ searchParams }: Pick<PageProps<"/admin/reclami">, "searchParams">) {
  await requireArea("admin", ADMIN_CLAIM_PATHS.list);
  await connection();
  const tab = parseAdminClaimTab((await searchParams).stato);

  const db = await createClient();
  const { data, error } = await db
    .from("claims")
    .select("id, order_id, category, description, created_at, closed_at, orders(order_number, customers(profiles(first_name, last_name, email))), claim_photos(count)")
    .eq("status", tab.status)
    .order(tab.status === "open" ? "created_at" : "closed_at", { ascending: tab.status === "open" })
    .limit(200)
    .returns<Row[]>();
  const now = new Date();

  return (
    <AdminShell title="Reclami">
      <nav className="mb-4 flex flex-wrap gap-2 text-sm">
        {ADMIN_CLAIM_TABS.map((t) => (
          <Link key={t.key} href={t.key === "aperti" ? ADMIN_CLAIM_PATHS.list : `${ADMIN_CLAIM_PATHS.list}?stato=${t.key}`} className={`rounded-full px-3 py-1 ${t.key === tab.key ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      {error ? <p className="text-sm text-red-700">Errore nel caricamento dei reclami.</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-2 pr-3 font-medium">Aperto</th>
              <th className="py-2 pr-3 font-medium">Ordine</th>
              <th className="py-2 pr-3 font-medium">Cliente</th>
              <th className="py-2 pr-3 font-medium">Tipo</th>
              <th className="py-2 font-medium">Descrizione</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((c) => {
              const p = c.orders?.customers?.profiles;
              const photos = c.claim_photos[0]?.count ?? 0;
              return (
                <tr key={c.id} className="border-t border-zinc-100 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <Link href={ADMIN_CLAIM_PATHS.detail(c.id)} className="text-blue-700 hover:underline">{rome(c.created_at)}</Link>
                    <div className="text-xs text-zinc-500">{tab.status === "open" ? claimAgeLabel(new Date(c.created_at), now) : `chiuso ${rome(c.closed_at ?? c.created_at)}`}</div>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <Link href={ADMIN_ORDER_PATHS.detail(c.order_id)} className="text-blue-700 hover:underline">{c.orders?.order_number}</Link>
                  </td>
                  <td className="py-2 pr-3">
                    {[p?.first_name, p?.last_name].filter(Boolean).join(" ") || "—"}
                    <div className="text-xs text-zinc-500">{p?.email}</div>
                  </td>
                  <td className="py-2 pr-3">{CLAIM_CATEGORY_LABEL[c.category]}{photos ? <div className="text-xs text-zinc-500">{photos} foto</div> : null}</td>
                  <td className="py-2 text-zinc-600">{c.description.length > 120 ? `${c.description.slice(0, 120)}…` : c.description}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && !data.length ? <p className="mt-4 text-sm text-zinc-600">{tab.status === "open" ? "Nessun reclamo aperto." : "Nessun reclamo chiuso."}</p> : null}
    </AdminShell>
  );
}
