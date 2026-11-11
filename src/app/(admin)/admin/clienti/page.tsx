import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { ADMIN_CUSTOMER_PATHS, CUSTOMER_TYPE_LABEL, customerDisplayName, customerSearchTerm } from "@/lib/customers/admin";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Clienti – Transigo" };

// Customers (spec 9, D143): list with search (name, e-mail, company, P.IVA, codice fiscale) and "Bloccati".
// Read with the admin's session (RLS: admins read all profiles and customers). The search term is sanitised
// (customerSearchTerm) before it goes into the PostgREST filters.
export default function Page({ searchParams }: PageProps<"/admin/clienti">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

type Row = {
  profile_id: string; customer_type: string; company_name: string | null; vat_number: string | null; created_at: string;
  profiles: { first_name: string | null; last_name: string | null; email: string; phone: string | null; is_blocked: boolean } | null;
  orders: { count: number }[];
};

const LIMIT = 200;
const date = (iso: string) => new Date(iso).toLocaleDateString("it-IT", { timeZone: "Europe/Rome" });

async function Content({ searchParams }: Pick<PageProps<"/admin/clienti">, "searchParams">) {
  await requireArea("admin", ADMIN_CUSTOMER_PATHS.list);
  const sp = await searchParams;
  const term = customerSearchTerm(sp.q);
  const onlyBlocked = sp.stato === "bloccati";
  const db = await createClient();

  // Search: ids from profiles (name, e-mail) and from customers (company, P.IVA, CF), then one list query.
  let ids: string[] | null = null;
  if (term) {
    const like = `*${term}*`;
    const [byProfile, byCustomer] = await Promise.all([
      db.from("profiles").select("id").eq("role", "cliente").or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like}`).limit(LIMIT),
      db.from("customers").select("profile_id").or(`company_name.ilike.${like},vat_number.ilike.${like},fiscal_code.ilike.${like}`).limit(LIMIT),
    ]);
    if (byProfile.error || byCustomer.error) throw new Error(`customer search failed: ${byProfile.error?.code ?? byCustomer.error?.code}`);
    ids = [...new Set([...byProfile.data.map((p) => p.id as string), ...byCustomer.data.map((c) => c.profile_id as string)])];
  }

  let q = db
    .from("customers")
    .select("profile_id, customer_type, company_name, vat_number, created_at, profiles!inner(first_name, last_name, email, phone, is_blocked), orders(count)")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (ids) q = q.in("profile_id", ids);
  if (onlyBlocked) q = q.eq("profiles.is_blocked", true);
  const { data, error } = await q.returns<Row[]>();

  const tabs = [
    { key: "tutti", label: "Tutti", href: ADMIN_CUSTOMER_PATHS.list },
    { key: "bloccati", label: "Bloccati", href: `${ADMIN_CUSTOMER_PATHS.list}?stato=bloccati` },
  ];
  return (
    <AdminShell title="Clienti">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <nav className="flex flex-wrap gap-2 text-sm">
          {tabs.map((t) => (
            <Link key={t.key} href={t.href} className={`rounded-full px-3 py-1 ${(t.key === "bloccati") === onlyBlocked ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"}`}>
              {t.label}
            </Link>
          ))}
        </nav>
        <form action={ADMIN_CUSTOMER_PATHS.list} className="flex gap-2 text-sm">
          {onlyBlocked ? <input type="hidden" name="stato" value="bloccati" /> : null}
          <label htmlFor="q" className="sr-only">Cerca cliente</label>
          <input id="q" name="q" type="search" defaultValue={typeof sp.q === "string" ? sp.q : ""} placeholder="Nome, e-mail, azienda, P.IVA, CF" className={`${inputClass} w-64`} />
          <button type="submit" className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-zinc-800 hover:bg-zinc-50">Cerca</button>
        </form>
      </div>
      {error ? <p className="text-sm text-red-700">Errore nel caricamento dei clienti.</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-2 pr-3 font-medium">Cliente</th>
              <th className="py-2 pr-3 font-medium">Tipo</th>
              <th className="py-2 pr-3 font-medium">Registrato</th>
              <th className="py-2 pr-3 text-right font-medium">Ordini</th>
              <th className="py-2 font-medium">Stato</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((c) => {
              const p = c.profiles;
              if (!p) return null;
              return (
                <tr key={c.profile_id} className="border-t border-zinc-100 align-top">
                  <td className="py-2 pr-3">
                    <Link href={ADMIN_CUSTOMER_PATHS.detail(c.profile_id)} className="text-blue-700 hover:underline">
                      {customerDisplayName({ ...c, first_name: p.first_name, last_name: p.last_name, email: p.email })}
                    </Link>
                    <div className="text-xs text-zinc-500">{p.email}{c.vat_number ? ` · P.IVA ${c.vat_number}` : ""}</div>
                  </td>
                  <td className="py-2 pr-3">{CUSTOMER_TYPE_LABEL[c.customer_type] ?? c.customer_type}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{date(c.created_at)}</td>
                  <td className="py-2 pr-3 text-right">{c.orders[0]?.count ?? 0}</td>
                  <td className="py-2">{p.is_blocked ? <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-900">Bloccato</span> : <span className="text-zinc-500">Attivo</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && !data.length ? <p className="mt-4 text-sm text-zinc-600">{term ? "Nessun cliente trovato." : "Nessun cliente."}</p> : null}
      {data && data.length === LIMIT ? <p className="mt-4 text-xs text-zinc-500">Mostrati i primi {LIMIT}: usa la ricerca per restringere.</p> : null}
    </AdminShell>
  );
}
