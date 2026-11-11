import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Loading } from "@/components/panel-shell";
import { AcceptJob } from "@/components/padroncino/accept-job";
import { bigButton, bigButtonSecondary, CarrierShell } from "@/components/padroncino/carrier-shell";
import { JobAmount, JobBlockers, JobFacts, Notice } from "@/components/padroncino/job-views";
import { RefreshButton } from "@/components/padroncino/refresh-button";
import { requireArea } from "@/lib/auth/session";
import { JOB_MSG, JOB_PATHS, romeWindow, routeLabel } from "@/lib/carriers/jobs";
import { loadAvailableJob, type AvailableJobPage } from "@/lib/carriers/jobs-server";
import { formatCents } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Dettagli corsa – Transigo" };

const back = { href: JOB_PATHS.available, label: "Corse disponibili" };

// One available job before accepting (D119): cities, provinces, floors, load, services and the carrier's amount —
// never a street, phone or customer name (list_available_jobs does not return them, so neither the HTML nor the
// props of AcceptJob can contain them). Overlap with own jobs is a warning only (D120).
export default function Page({ params }: PageProps<"/padroncino/corse/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: Pick<PageProps<"/padroncino/corse/[id]">, "params">) {
  const { id } = await params;
  const ctx = await requireArea("padroncino", JOB_PATHS.available_job(id));

  let page: AvailableJobPage | null = null;
  try {
    page = await loadAvailableJob(await createClient(), ctx.userId, id);
  } catch {
    page = null; // logged in jobs-server.ts
  }

  if (page?.kind === "mine") redirect(JOB_PATHS.my_job(id));

  if (page === null) {
    return (
      <CarrierShell title="Dettagli corsa" back={back}>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p role="alert" className="font-medium text-red-800">Non è stato possibile caricare la corsa.</p>
          <div className="mt-4">
            <RefreshButton label="Riprova" pendingLabel="Caricamento…" className={bigButton} />
          </div>
        </div>
      </CarrierShell>
    );
  }

  if (page.kind === "blocked") {
    return (
      <CarrierShell title="Dettagli corsa" back={back}>
        <JobBlockers blockers={page.blockers} />
      </CarrierShell>
    );
  }

  if (page.kind === "unavailable") {
    return (
      <CarrierShell title="Corsa non disponibile" back={back}>
        <div className="space-y-4">
          <Notice tone="info">{JOB_MSG.notAvailable} Potrebbe essere già stata accettata da un altro padroncino.</Notice>
          <Link href={JOB_PATHS.available} className={bigButtonSecondary}>Vedi le corse disponibili</Link>
        </div>
      </CarrierShell>
    );
  }

  const { job, vehicles, overlaps } = page;
  const when = romeWindow(job.pickupWindowStart, job.pickupWindowEnd);

  return (
    <CarrierShell title={job.porters ? `Facchinaggio ${job.orderNumber}` : `Corsa ${job.orderNumber}`} back={back}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-600">
          Indirizzi completi, contatti e note del cliente sono visibili dopo l&apos;accettazione.
        </p>

        {overlaps.length ? (
          <Notice tone="info">
            <p className="font-medium">Attenzione: si sovrappone con {overlaps.length === 1 ? "la tua corsa" : "le tue corse"}{" "}
              {overlaps.map((o, i) => (
                <span key={o.orderId}>
                  {i > 0 ? ", " : ""}
                  <Link href={JOB_PATHS.my_job(o.orderId)} className="underline">{o.orderNumber}</Link>
                </span>
              ))}
              .
            </p>
            <p className="mt-1">Puoi accettarla lo stesso, se riesci a fare entrambe.</p>
          </Notice>
        ) : null}

        <JobAmount amount={job.amount} />
        <JobFacts job={job} />

        {job.porters ? (
          <AcceptJob
            orderId={job.orderId}
            vehicles={[]}
            porters={`${job.porters.persons} facchini · ${job.porters.hours} h`}
            summary={{ orderNumber: job.orderNumber, route: routeLabel(job.stops), when, amount: formatCents(job.amount.totalCents) }}
          />
        ) : vehicles.length ? (
          <AcceptJob
            orderId={job.orderId}
            vehicles={vehicles.map((v) => ({ id: v.id, label: `${v.vehicleTypeName} · ${v.plate}` }))}
            summary={{ orderNumber: job.orderNumber, route: routeLabel(job.stops), when, amount: formatCents(job.amount.totalCents) }}
          />
        ) : (
          <Notice tone="error">Nessuno dei tuoi veicoli pronti è adatto a questa corsa.</Notice>
        )}
      </div>
    </CarrierShell>
  );
}
