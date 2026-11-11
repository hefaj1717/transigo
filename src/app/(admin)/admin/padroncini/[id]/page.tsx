import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell } from "@/components/admin/admin-nav";
import { AdminCarrierCompanyForm } from "@/components/admin/carrier-company-form";
import { requireArea } from "@/lib/auth/session";
import {
  ADMIN_CARRIER_PATHS,
  CARRIER_STATUS_LABEL,
  canReviewSingly,
  carrierAccountTab,
  describeMissingForAdmin,
  REASON_MAX,
} from "@/lib/carriers/admin";
import {
  countActiveJobs,
  loadAdminCarrier,
  loadAdminDocuments,
  loadAdminVehicles,
  loadMissing,
  loadPorterJobsInProgress,
  type AdminDocumentRow,
  type AdminVehicleRow,
} from "@/lib/carriers/admin-pages";
import { CARRIER_DOCUMENT_TYPES, type CarrierDocumentTypeConfig } from "@/lib/carriers/document-types";
import { romeToday } from "@/lib/carriers/documents";
import { signedDocumentUrls } from "@/lib/carriers/pages";
import { vehicleApprovalState } from "@/lib/carriers/vehicles";
import { createClient } from "@/lib/supabase/server";
import { approveVehicleAction, decideCarrierAction, reviewDocumentAction, setCarrierPortersAction, setSuspensionAction } from "../actions";

export const metadata = { title: "Padroncino – Transigo" };

// One carrier for the admin (D101, D103, D105, D113–D116): company data (editable through
// admin_update_carrier_company), vehicles with their documents, company documents, and the decisions allowed
// in the current state. Files open through 5-minute signed links created with the admin's session (D103).
export default function Page({ params }: PageProps<"/admin/padroncini/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} />
    </Suspense>
  );
}

const rome = (iso: string | null) => (iso ? new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }) : "—");
const itDate = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "—");
const textareaClass = "block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900";
const section = "mt-8";
const h2 = "mb-3 text-lg font-semibold text-zinc-900";

async function Content({ params }: Pick<PageProps<"/admin/padroncini/[id]">, "params">) {
  const { id } = await params;
  await requireArea("admin", ADMIN_CARRIER_PATHS.detail(id));
  if (!z.uuid().safeParse(id).success) notFound();

  const db = await createClient(); // admin's session (RLS, storage policy)
  const carrier = await loadAdminCarrier(db, id);
  if (!carrier) notFound();
  const [vehicles, documents, missing, activeJobs, porterJobs] = await Promise.all([
    loadAdminVehicles(db, id), loadAdminDocuments(db, id), loadMissing(db, id), countActiveJobs(db, id), loadPorterJobsInProgress(db, id),
  ]);
  const urls = await signedDocumentUrls(db, documents);

  const tab = carrierAccountTab(carrier.status, carrier.submitted_at);
  const single = canReviewSingly(carrier.status);
  const pendingDocs = documents.filter((d) => d.review_status === "pending" && (!d.vehicle_id || vehicles.find((v) => v.id === d.vehicle_id)?.is_active));
  const owner = [carrier.profiles?.first_name, carrier.profiles?.last_name].filter(Boolean).join(" ");
  const companyTypes = CARRIER_DOCUMENT_TYPES.filter((t) => t.scope === "carrier");
  const vehicleTypes = CARRIER_DOCUMENT_TYPES.filter((t) => t.scope === "vehicle");

  return (
    <AdminShell title={carrier.company_name || "Padroncino"}>
      <p className="mb-4 text-sm"><Link href={ADMIN_CARRIER_PATHS.tab(tab)} className="text-blue-700 hover:underline">← Padroncini</Link></p>

      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tab={tab} />
        {carrier.profiles?.is_blocked ? <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">Account bloccato (accesso)</span> : null}
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <Row label="Titolare">{owner || "—"}</Row>
        <Row label="E-mail">{carrier.profiles?.email ?? "—"}</Row>
        <Row label="Telefono">{carrier.profiles?.phone ?? "—"}{carrier.phone_verified_at ? " (verificato)" : ""}</Row>
        <Row label="Stripe">{carrier.stripe_payouts_enabled ? "Pagamenti attivi" : "Non collegato"}</Row>
        <Row label="Registrato">{rome(carrier.created_at)}</Row>
        <Row label="Inviato per la verifica">{rome(carrier.submitted_at)}</Row>
        <Row label="Ultima decisione">{rome(carrier.decided_at)}</Row>
        <Row label="Attivato">{rome(carrier.activated_at)}</Row>
      </dl>
      {carrier.status_reason ? (
        <p className="mt-3 rounded-md bg-zinc-50 p-3 text-sm"><span className="text-zinc-500">Motivo ({CARRIER_STATUS_LABEL[tab].toLowerCase()}): </span><span className="whitespace-pre-line">{carrier.status_reason}</span></p>
      ) : null}

      {activeJobs > 0 && carrier.status === "suspended" ? (
        <p role="alert" className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Attenzione: il padroncino è sospeso ma ha {activeJobs} {activeJobs === 1 ? "corsa accettata" : "corse accettate"} non ancora {activeJobs === 1 ? "consegnata" : "consegnate"}. Le corse restano sue e i pagamenti delle consegne procedono normalmente.
        </p>
      ) : null}

      <section className={section} aria-labelledby="missing">
        <h2 id="missing" className={h2}>Completezza</h2>
        {missing.length ? (
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-red-700">
            {describeMissingForAdmin(missing, vehicles).map((m) => <li key={m}>{m}</li>)}
          </ul>
        ) : <p className="text-sm text-green-800">Dati, veicoli e documenti obbligatori completi e validi.</p>}
      </section>

      <Decisions carrierId={id} tab={tab} activeJobs={activeJobs} pendingDocs={pendingDocs.length} complete={!missing.length} />

      <PortersSettings carrierId={id} offers={carrier.offers_porters} team={carrier.porters_team_size} jobs={porterJobs} />

      <section className={section} aria-labelledby="company">
        <h2 id="company" className={h2}>Dati aziendali</h2>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Row label="Partita IVA"><span className="font-mono">{carrier.vat_number}</span></Row>
          <Row label="Codice fiscale"><span className="font-mono">{carrier.fiscal_code ?? "—"}</span></Row>
          <Row label="Sede">{[carrier.hq_street, [carrier.hq_postal_code, carrier.hq_city].filter(Boolean).join(" "), carrier.hq_province].filter(Boolean).join(", ") || "—"}</Row>
          <Row label="SDI / PEC">{[carrier.sdi_code, carrier.pec].filter(Boolean).join(" · ") || "—"}</Row>
        </dl>
        <details className="mt-3 rounded-md border border-zinc-200 p-3">
          <summary className="cursor-pointer text-sm font-medium text-blue-700">Modifica dati aziendali</summary>
          <div className="mt-3">
            <AdminCarrierCompanyForm carrierId={id} initial={{
              companyName: carrier.company_name ?? "", vatNumber: carrier.vat_number ?? "", fiscalCode: carrier.fiscal_code ?? "",
              hqStreet: carrier.hq_street ?? "", hqCity: carrier.hq_city ?? "", hqPostalCode: carrier.hq_postal_code ?? "",
              hqProvince: carrier.hq_province ?? "", sdiCode: carrier.sdi_code ?? "", pec: carrier.pec ?? "",
            }} />
          </div>
        </details>
      </section>

      <section className={section} aria-labelledby="company-docs">
        <h2 id="company-docs" className={h2}>Documenti aziendali</h2>
        <DocumentGroups types={companyTypes} docs={documents.filter((d) => !d.vehicle_id)} urls={urls} reviewable={single} />
      </section>

      <section className={section} aria-labelledby="vehicles">
        <h2 id="vehicles" className={h2}>Veicoli</h2>
        {vehicles.length ? (
          <ul className="space-y-4">
            {vehicles.map((v) => (
              <VehicleCard key={v.id} vehicle={v} types={vehicleTypes} docs={documents.filter((d) => d.vehicle_id === v.id)} urls={urls} reviewable={single} />
            ))}
          </ul>
        ) : <p className="text-sm text-zinc-600">Nessun veicolo.</p>}
      </section>

      {!single && pendingDocs.length ? (
        <p className="mt-6 text-xs text-zinc-500">I documenti in attesa di un padroncino in verifica si approvano tutti insieme con «Approva padroncino».</p>
      ) : null}
    </AdminShell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-zinc-500">{label}:</dt>
      <dd className="text-zinc-900">{children}</dd>
    </div>
  );
}

const BADGE: Record<string, string> = {
  "da-verificare": "bg-amber-100 text-amber-900",
  incompleti: "bg-zinc-100 text-zinc-800",
  attivi: "bg-green-100 text-green-900",
  sospesi: "bg-red-100 text-red-800",
  rifiutati: "bg-red-100 text-red-800",
};

function StatusBadge({ tab }: { tab: ReturnType<typeof carrierAccountTab> }) {
  return <span className={`rounded px-2 py-0.5 text-sm font-medium ${BADGE[tab]}`}>{CARRIER_STATUS_LABEL[tab]}</span>;
}

function ReasonField({ id, label }: { id: string; label: string }) {
  return (
    <label htmlFor={id} className="block text-sm font-medium text-zinc-800">
      {label} <span className="text-red-600">*</span>
      <textarea id={id} name="reason" required maxLength={REASON_MAX} rows={3} className={`${textareaClass} mt-1`} />
      <span className="mt-1 block text-xs font-normal text-zinc-500">Il padroncino vedrà questo testo (app ed e-mail).</span>
    </label>
  );
}

function Decisions({ carrierId, tab, activeJobs, pendingDocs, complete }: { carrierId: string; tab: string; activeJobs: number; pendingDocs: number; complete: boolean }) {
  if (tab === "da-verificare") {
    return (
      <section className={section} aria-labelledby="decision">
        <h2 id="decision" className={h2}>Decisione</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <ActionForm action={decideCarrierAction} submitLabel="Approva padroncino" className="rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="id" value={carrierId} />
            <input type="hidden" name="decision" value="approve" />
            <p className="text-sm text-zinc-700">Attiva l&apos;account e approva i veicoli e i documenti inviati per la verifica.</p>
            {!complete ? <p className="mt-1 text-sm text-red-700">La registrazione non è completa: l&apos;approvazione verrà rifiutata.</p> : null}
          </ActionForm>
          <ActionForm action={decideCarrierAction} submitLabel="Rifiuta" variant="danger" className="rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="id" value={carrierId} />
            <input type="hidden" name="decision" value="reject" />
            <ReasonField id="reject-reason" label="Motivo del rifiuto" />
          </ActionForm>
        </div>
      </section>
    );
  }
  if (tab === "attivi") {
    return (
      <section className={section} aria-labelledby="decision">
        <h2 id="decision" className={h2}>Sospensione</h2>
        <ActionForm action={setSuspensionAction} submitLabel="Sospendi" variant="danger" className="max-w-xl rounded-md border border-zinc-200 p-3">
          <input type="hidden" name="id" value={carrierId} />
          <input type="hidden" name="decision" value="suspend" />
          <p className="mb-2 text-sm text-zinc-700">Il padroncino sospeso non vede e non accetta nuove corse. Le corse già accettate restano sue; i pagamenti delle consegne procedono normalmente.</p>
          {activeJobs > 0 ? (
            <p role="alert" className="mb-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900">
              Ha {activeJobs} {activeJobs === 1 ? "corsa accettata" : "corse accettate"} non ancora {activeJobs === 1 ? "consegnata" : "consegnate"}: {activeJobs === 1 ? "resterà" : "resteranno"} a lui.
            </p>
          ) : null}
          <ReasonField id="suspend-reason" label="Motivo della sospensione" />
        </ActionForm>
      </section>
    );
  }
  if (tab === "sospesi") {
    return (
      <section className={section} aria-labelledby="decision">
        <h2 id="decision" className={h2}>Riattivazione</h2>
        <ActionForm action={setSuspensionAction} submitLabel="Riattiva" className="max-w-xl rounded-md border border-zinc-200 p-3">
          <input type="hidden" name="id" value={carrierId} />
          <input type="hidden" name="decision" value="reactivate" />
          <p className="text-sm text-zinc-700">Possibile quando la registrazione è completa e nessun documento è in attesa di verifica.</p>
          {pendingDocs > 0 ? <p className="mt-1 text-sm text-amber-900">{pendingDocs === 1 ? "1 documento è" : `${pendingDocs} documenti sono`} in attesa di verifica: valutali qui sotto prima di riattivare.</p> : null}
          {!complete ? <p className="mt-1 text-sm text-red-700">La registrazione non è completa (vedi sopra).</p> : null}
        </ActionForm>
      </section>
    );
  }
  return null;
}

const STATUS_TONE = { pending: "bg-amber-100 text-amber-900", approved: "bg-green-100 text-green-900", rejected: "bg-red-100 text-red-800" } as const;
const STATUS_TEXT = { pending: "In attesa di verifica", approved: "Approvato", rejected: "Rifiutato" } as const;

function DocumentGroups({ types, docs, urls, reviewable }: { types: CarrierDocumentTypeConfig[]; docs: AdminDocumentRow[]; urls: Map<string, string>; reviewable: boolean }) {
  // Types still accepted, plus any old type that has uploads.
  const shown = types.filter((t) => t.isAccepted || docs.some((d) => d.doc_type === t.docType)).sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <ul className="space-y-3">
      {shown.map((t) => {
        const list = docs.filter((d) => d.doc_type === t.docType); // newest first
        return (
          <li key={t.docType} className="rounded-md border border-zinc-200 bg-white p-3">
            <h3 className="text-sm font-semibold text-zinc-900">
              {t.labelIt}
              {t.isRequired ? null : <span className="ml-2 text-xs font-normal text-zinc-500">facoltativo</span>}
            </h3>
            {list.length ? (
              <ul className="mt-2 space-y-2">
                {list.map((d, i) => <DocumentItem key={d.id} doc={d} url={urls.get(d.id)} older={i > 0} expiryLabel={t.expiryLabelIt} reviewable={reviewable} />)}
              </ul>
            ) : <p className="mt-1 text-sm text-zinc-600">Non caricato.</p>}
          </li>
        );
      })}
    </ul>
  );
}

function DocumentItem({ doc, url, older, expiryLabel, reviewable }: { doc: AdminDocumentRow; url?: string; older: boolean; expiryLabel: string | null; reviewable: boolean }) {
  const expired = !!doc.expires_at && doc.expires_at < romeToday();
  return (
    <li id={`doc-${doc.id}`} className={`scroll-mt-20 text-sm ${older ? "border-t border-zinc-100 pt-2 text-zinc-500" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_TONE[doc.review_status]}`}>{STATUS_TEXT[doc.review_status]}</span>
        {expired ? <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">Scaduto</span> : null}
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-700 underline">
            {doc.mime_type === "image/heic" ? "Scarica" : "Apri"} {doc.file_name}
          </a>
        ) : <span>{doc.file_name}</span>}
        <span className="text-xs text-zinc-500">caricato {rome(doc.created_at)}{doc.expires_at ? ` · ${expiryLabel ?? "Scadenza"}: ${itDate(doc.expires_at)}` : ""}</span>
        {older ? <span className="text-xs text-zinc-500">(versione precedente)</span> : null}
      </div>
      {doc.review_status === "rejected" && doc.rejection_reason ? <p className="mt-1 whitespace-pre-line text-xs text-red-700">Motivo: {doc.rejection_reason}</p> : null}
      {reviewable && doc.review_status === "pending" ? (
        <div className="mt-2 grid gap-3 sm:grid-cols-[auto_1fr]">
          <ActionForm action={reviewDocumentAction} submitLabel="Approva documento">
            <input type="hidden" name="id" value={doc.id} />
            <input type="hidden" name="decision" value="approve" />
          </ActionForm>
          <ActionForm action={reviewDocumentAction} submitLabel="Rifiuta documento" variant="danger">
            <input type="hidden" name="id" value={doc.id} />
            <input type="hidden" name="decision" value="reject" />
            <ReasonField id={`reason-${doc.id}`} label="Motivo del rifiuto" />
          </ActionForm>
        </div>
      ) : null}
    </li>
  );
}

function VehicleCard({ vehicle: v, types, docs, urls, reviewable }: { vehicle: AdminVehicleRow; types: CarrierDocumentTypeConfig[]; docs: AdminDocumentRow[]; urls: Map<string, string>; reviewable: boolean }) {
  const state = vehicleApprovalState(v);
  const dims = [v.cargo_length_cm, v.cargo_width_cm, v.cargo_height_cm].every((x) => x != null) ? `${v.cargo_length_cm}×${v.cargo_width_cm}×${v.cargo_height_cm} cm` : null;
  return (
    <li id={`vehicle-${v.id}`} className={`scroll-mt-20 rounded-md border p-4 ${v.is_active ? "border-zinc-200" : "border-dashed border-zinc-300 bg-zinc-50"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-base font-semibold text-zinc-900">{v.plate}</span>
        <span className="text-sm text-zinc-700">{v.vehicle_types?.name_it ?? "—"} · {v.payload_kg} kg{dims ? ` · ${dims}` : ""}</span>
        {!v.is_active ? <span className="rounded bg-zinc-200 px-2 py-0.5 text-xs text-zinc-700">Disattivato</span>
          : state === "approved" ? <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-900">Approvato</span>
          : state === "reverify" ? <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Da riverificare (tipo o portata cambiati)</span>
          : <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-900">Nuovo veicolo</span>}
      </div>
      <div className="mt-3">
        <DocumentGroups types={types} docs={docs} urls={urls} reviewable={reviewable} />
      </div>
      {/* D114: approve only here, below the vehicle's documents, so the admin sees what is approved with it. */}
      {reviewable && v.is_active && state !== "approved" ? (
        <ActionForm action={approveVehicleAction} submitLabel="Approva veicolo" className="mt-3 rounded-md bg-zinc-50 p-3">
          <input type="hidden" name="id" value={v.id} />
          <p className="text-sm text-zinc-700">Approva il veicolo insieme ai suoi documenti in attesa e validi (elencati sopra).</p>
        </ActionForm>
      ) : null}
    </li>
  );
}

/**
 * Facchinaggio (D152, D167): who may receive porter jobs and with which team. A change applies to new jobs only;
 * jobs in progress stay with the carrier — the list warns about those that would need more persons than the team.
 */
function PortersSettings({ carrierId, offers, team, jobs }: { carrierId: string; offers: boolean; team: number | null; jobs: { id: string; order_number: string; persons: number }[] }) {
  return (
    <section className={section} aria-labelledby="porters">
      <h2 id="porters" className={h2}>Facchinaggio</h2>
      <p className="text-sm text-zinc-700">
        {offers ? `Offre il facchinaggio con una squadra di ${team} persone: riceve i lavori fino a ${team} facchini.` : "Non offre il facchinaggio: non riceve lavori di facchinaggio."}
      </p>
      {jobs.length ? (
        <p className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          {jobs.length === 1 ? "1 lavoro di facchinaggio in corso" : `${jobs.length} lavori di facchinaggio in corso`}: restano al padroncino anche se cambi la squadra.{" "}
          {jobs.map((j, i) => (
            <span key={j.id}>{i ? ", " : ""}<Link href={`/admin/ordini/${j.id}`} className="underline">{j.order_number}</Link> ({j.persons} facchini)</span>
          ))}
        </p>
      ) : null}
      <ActionForm action={setCarrierPortersAction} submitLabel="Salva" className="mt-3 max-w-md rounded-md border border-zinc-200 p-3">
        <input type="hidden" name="id" value={carrierId} />
        <label className="flex items-center gap-2 text-sm text-zinc-800">
          <input type="checkbox" name="offers" defaultChecked={offers} />
          Offre facchinaggio
        </label>
        <label htmlFor="porters-team" className="mt-2 block text-sm font-medium text-zinc-800">Squadra (persone)</label>
        <select id="porters-team" name="team" defaultValue={String(team ?? 2)} className="mt-1 block w-32 rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900">
          {[2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <p className="mt-1 text-xs text-zinc-500">Vale per i nuovi lavori. Senza la spunta la squadra non conta.</p>
      </ActionForm>
    </section>
  );
}
