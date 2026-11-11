import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { AdminShell } from "@/components/admin/admin-nav";
import { ADMIN_DOC_COLUMNS, AdminInvoiceTable, type AdminDoc, type DocTech } from "@/components/admin/invoice-table";
import { Loading } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";
import { ADMIN_INVOICE_PATHS, ADMIN_INVOICE_TABS, parseAdminInvoiceTab } from "@/lib/einvoice/view";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Fatture – Transigo" };

// Invoices and credit notes (D144–D148): "Da emettere / in errore" (oldest first, with "Riprova") and "Emesse"
// (newest first). Read with the admin's session; the technical columns through admin_invoice_errors().
export default function Page({ searchParams }: PageProps<"/admin/fatture">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: Pick<PageProps<"/admin/fatture">, "searchParams">) {
  await requireArea("admin", ADMIN_INVOICE_PATHS.list);
  await connection();
  const tab = parseAdminInvoiceTab((await searchParams).stato);
  const db = await createClient();
  const base = db.from("invoices").select(`${ADMIN_DOC_COLUMNS}, orders(order_number)`);
  const [docsRes, techRes] = await Promise.all([
    (tab === "emesse" ? base.eq("status", "issued").order("issued_at", { ascending: false }) : base.neq("status", "issued").order("created_at", { ascending: true }))
      .limit(300)
      .returns<AdminDoc[]>(),
    tab === "emesse" ? Promise.resolve({ data: [] as DocTech[], error: null }) : db.rpc("admin_invoice_errors").returns<DocTech[]>(),
  ]);
  const tech = new Map(((techRes.data ?? []) as DocTech[]).map((t) => [t.invoice_id, t]));
  const docs = docsRes.data ?? [];
  const demo = docs.some((d) => d.is_demo);

  return (
    <AdminShell title="Fatture">
      <nav className="mb-4 flex flex-wrap gap-2 text-sm">
        {ADMIN_INVOICE_TABS.map((t) => (
          <Link key={t.key} href={ADMIN_INVOICE_PATHS.tab(t.key)} className={`rounded-full px-3 py-1 ${t.key === tab ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      {demo ? <p className="mb-3 rounded-md bg-red-50 p-2 text-sm text-red-800">Adattatore DEMO: documenti senza valore fiscale, non trasmessi allo SDI (D144).</p> : null}
      {docsRes.error || techRes.error ? <p className="text-sm text-red-700">Errore nel caricamento delle fatture.</p> : null}
      {docs.length ? (
        <AdminInvoiceTable docs={docs} tech={tech} showOrder />
      ) : (
        <p className="text-sm text-zinc-600">{tab === "emesse" ? "Nessun documento emesso." : "Nessun documento da emettere o in errore."}</p>
      )}
      {tab === "da-emettere" ? (
        <p className="mt-4 text-xs text-zinc-500">
          Il job periodico /api/cron/einvoice riprova da solo fino a 5 volte (ogni ≥ 10 min); dopo, solo «Riprova». Una nota di credito attende l&apos;emissione della sua fattura.
        </p>
      ) : null}
    </AdminShell>
  );
}
