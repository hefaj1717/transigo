import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { AdminShell } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import {
  ADMIN_CARRIER_PATHS,
  ADMIN_CARRIER_TABS,
  carrierAccountTab,
  describeMissingForAdmin,
  parseAdminCarrierTab,
  type AdminCarrierTab,
} from "@/lib/carriers/admin";
import {
  loadAdminCarriers,
  loadMissing,
  loadPendingDocuments,
  loadPendingVehicles,
  type AdminCarrierListRow,
} from "@/lib/carriers/admin-pages";
import { documentTypeConfig } from "@/lib/carriers/document-types";
import { vehicleApprovalState } from "@/lib/carriers/vehicles";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Padroncini – Transigo" };

// Carriers for the admin (D100, D101, D113–D115): accounts by state, plus the queues of vehicles and documents
// of active / suspended carriers waiting for review. Decisions are on the carrier's detail page.
export default function Page({ searchParams }: PageProps<"/admin/padroncini">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

const rome = (iso: string | null) => (iso ? new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }) : "—");
const itDate = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "—");
const th = "px-3 py-2 text-left text-xs font-medium uppercase text-zinc-500";
const td = "px-3 py-2 align-top";

async function Content({ searchParams }: Pick<PageProps<"/admin/padroncini">, "searchParams">) {
  await requireArea("admin", ADMIN_CARRIER_PATHS.list);
  const tab = parseAdminCarrierTab((await searchParams).tab);
  const db = await createClient(); // admin's session (RLS)

  const [carriers, vehicles, documents] = await Promise.all([loadAdminCarriers(db), loadPendingVehicles(db), loadPendingDocuments(db)]);
  const byTab = new Map<AdminCarrierTab, AdminCarrierListRow[]>();
  for (const c of carriers) {
    const key = carrierAccountTab(c.status, c.submitted_at);
    byTab.set(key, [...(byTab.get(key) ?? []), c]);
  }
  const count = (key: AdminCarrierTab) => (key === "veicoli" ? vehicles.length : key === "documenti" ? documents.length : (byTab.get(key)?.length ?? 0));

  return (
    <AdminShell title="Padroncini">
      <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtri">
        {ADMIN_CARRIER_TABS.map((t) => {
          const n = count(t.key);
          const active = t.key === tab;
          return (
            <Link key={t.key} href={ADMIN_CARRIER_PATHS.tab(t.key)} aria-current={active ? "page" : undefined}
              className={`rounded-full px-3 py-1 ${active ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"}`}>
              {t.label} <span className={active ? "text-blue-100" : "text-zinc-500"}>({n})</span>
            </Link>
          );
        })}
      </nav>

      {tab === "veicoli" ? (
        <VehiclesQueue rows={vehicles} />
      ) : tab === "documenti" ? (
        <DocumentsQueue rows={documents} />
      ) : (
        <CarrierTable tab={tab} rows={tab === "da-verificare" ? [...(byTab.get(tab) ?? [])].sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? "")) : (byTab.get(tab) ?? [])} />
      )}
    </AdminShell>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="rounded-md bg-zinc-50 p-4 text-sm text-zinc-600">{children}</p>;
}

function Company({ id, name }: { id: string; name: string }) {
  return <Link href={ADMIN_CARRIER_PATHS.detail(id)} className="font-medium text-blue-700 hover:underline">{name}</Link>;
}

async function CarrierTable({ tab, rows }: { tab: AdminCarrierTab; rows: AdminCarrierListRow[] }) {
  if (!rows.length) return <Empty>Nessun padroncino in questo elenco.</Empty>;
  // Only the "incomplete" tab shows what is missing (one database call per carrier).
  const db = await createClient();
  const missing = tab === "incompleti"
    ? new Map(await Promise.all(rows.slice(0, 100).map(async (r) => [r.profile_id, await loadMissing(db, r.profile_id)] as const)))
    : null;
  const dateLabel = { "da-verificare": "Inviato", incompleti: "Registrato", attivi: "Attivato", sospesi: "Registrato", rifiutati: "Rifiutato" }[tab as string];

  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200">
      <table className="min-w-full divide-y divide-zinc-200 text-sm">
        <thead className="bg-zinc-50">
          <tr>
            <th className={th}>Ragione sociale</th>
            <th className={th}>P.IVA</th>
            <th className={th}>Titolare</th>
            <th className={th}>{dateLabel}</th>
            {tab === "incompleti" ? <th className={th}>Mancano</th> : null}
            {tab === "sospesi" || tab === "rifiutati" ? <th className={th}>Motivo</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 bg-white">
          {rows.map((r) => {
            const name = [r.profiles?.first_name, r.profiles?.last_name].filter(Boolean).join(" ");
            const date = tab === "da-verificare" ? r.submitted_at : tab === "attivi" ? r.activated_at : tab === "rifiutati" ? r.decided_at : r.created_at;
            const m = missing?.get(r.profile_id);
            return (
              <tr key={r.profile_id}>
                <td className={td}><Company id={r.profile_id} name={r.company_name || "—"} /></td>
                <td className={`${td} font-mono text-xs`}>{r.vat_number}</td>
                <td className={td}>{name || "—"}<div className="text-xs text-zinc-500">{r.profiles?.email}</div></td>
                <td className={`${td} whitespace-nowrap`}>{rome(date)}</td>
                {tab === "incompleti" ? (
                  <td className={`${td} text-xs`}>{m ? (m.length ? describeMissingForAdmin(m, []).join(", ") : "Pronto per l'invio") : "—"}</td>
                ) : null}
                {tab === "sospesi" || tab === "rifiutati" ? <td className={`${td} max-w-xs text-xs`}>{r.status_reason ?? "—"}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VehiclesQueue({ rows }: { rows: Awaited<ReturnType<typeof loadPendingVehicles>> }) {
  if (!rows.length) return <Empty>Nessun veicolo da verificare.</Empty>;
  return (
    <>
      <p className="mb-3 text-sm text-zinc-600">Veicoli di padroncini attivi o sospesi in attesa di approvazione. Si approvano dalla pagina del padroncino, dopo aver visto i documenti del veicolo.</p>
      <div className="overflow-x-auto rounded-md border border-zinc-200">
        <table className="min-w-full divide-y divide-zinc-200 text-sm">
          <thead className="bg-zinc-50">
            <tr><th className={th}>Targa</th><th className={th}>Tipo</th><th className={th}>Padroncino</th><th className={th}>Stato</th><th className={th}>Modificato</th></tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 bg-white">
            {rows.map((v) => (
              <tr key={v.id}>
                <td className={`${td} font-mono`}>{v.plate}</td>
                <td className={td}>{v.vehicle_types?.name_it ?? "—"} · {v.payload_kg} kg</td>
                <td className={td}>
                  <Company id={v.carrier_id} name={v.carriers.company_name} />
                  {v.carriers.status === "suspended" ? <span className="ml-2 text-xs text-red-700">sospeso</span> : null}
                </td>
                <td className={td}>
                  {vehicleApprovalState(v) === "reverify"
                    ? <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Da riverificare</span>
                    : <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-900">Nuovo veicolo</span>}
                </td>
                <td className={`${td} whitespace-nowrap`}>{rome(v.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DocumentsQueue({ rows }: { rows: Awaited<ReturnType<typeof loadPendingDocuments>> }) {
  if (!rows.length) return <Empty>Nessun documento da verificare.</Empty>;
  return (
    <>
      <p className="mb-3 text-sm text-zinc-600">Documenti caricati da padroncini attivi o sospesi (es. assicurazione rinnovata). Si valutano dalla pagina del padroncino.</p>
      <div className="overflow-x-auto rounded-md border border-zinc-200">
        <table className="min-w-full divide-y divide-zinc-200 text-sm">
          <thead className="bg-zinc-50">
            <tr><th className={th}>Documento</th><th className={th}>Padroncino</th><th className={th}>Scadenza</th><th className={th}>Caricato</th></tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 bg-white">
            {rows.map((d) => (
              <tr key={d.id}>
                <td className={td}>
                  {documentTypeConfig(d.doc_type).labelIt}
                  {d.carrier_vehicles ? <span className="ml-1 font-mono text-xs text-zinc-600">{d.carrier_vehicles.plate}{d.carrier_vehicles.is_active ? "" : " (disattivato)"}</span> : null}
                </td>
                <td className={td}>
                  <Link href={`${ADMIN_CARRIER_PATHS.detail(d.carrier_id)}#doc-${d.id}`} className="font-medium text-blue-700 hover:underline">{d.carriers.company_name}</Link>
                  {d.carriers.status === "suspended" ? <span className="ml-2 text-xs text-red-700">sospeso</span> : null}
                </td>
                <td className={`${td} whitespace-nowrap`}>{itDate(d.expires_at)}</td>
                <td className={`${td} whitespace-nowrap`}>{rome(d.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
