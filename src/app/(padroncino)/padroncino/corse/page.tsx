import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { bigButton, bigButtonSecondary, CarrierShell } from "@/components/padroncino/carrier-shell";
import { JobBlockers, JobListCard, Notice } from "@/components/padroncino/job-views";
import { RefreshButton } from "@/components/padroncino/refresh-button";
import { requireArea } from "@/lib/auth/session";
import { JOB_PATHS, jobListNotice } from "@/lib/carriers/jobs";
import { listAvailableJobs, type AvailableJobsResult } from "@/lib/carriers/jobs-server";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Corse disponibili – Transigo" };

// "Corse disponibili" (D119, D120): cards without personal data, "Aggiorna", the blockers instead of the list
// (D21, D116), an error state with "Riprova", and the notice after a failed accept (?avviso=, e.g. already_taken).
export default function Page({ searchParams }: PageProps<"/padroncino/corse">) {
  return (
    <CarrierShell title="Corse disponibili">
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </CarrierShell>
  );
}

async function Content({ searchParams }: Pick<PageProps<"/padroncino/corse">, "searchParams">) {
  await requireArea("padroncino", JOB_PATHS.available);
  const notice = jobListNotice((await searchParams).avviso);

  let result: AvailableJobsResult | null = null;
  try {
    result = await listAvailableJobs(await createClient());
  } catch {
    result = null; // logged in jobs-server.ts (codes only)
  }

  const refresh = (
    <RefreshButton label="Aggiorna" pendingLabel="Aggiornamento…" href={JOB_PATHS.available} className={bigButtonSecondary} />
  );

  return (
    <div className="space-y-4">
      {notice ? <Notice tone="info">{notice} L&apos;elenco è stato aggiornato.</Notice> : null}

      {result === null ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p role="alert" className="font-medium text-red-800">Non è stato possibile caricare le corse.</p>
          <p className="mt-1 text-sm text-red-800">Controlla la connessione e riprova.</p>
          <div className="mt-4">
            <RefreshButton label="Riprova" pendingLabel="Caricamento…" className={bigButton} />
          </div>
        </div>
      ) : !result.ok ? (
        <JobBlockers blockers={result.blockers} />
      ) : result.jobs.length === 0 ? (
        <>
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-center">
            <p className="font-medium text-zinc-900">Nessuna corsa disponibile al momento</p>
            <p className="mt-1 text-sm text-zinc-600">Vedi solo le corse adatte ai tuoi veicoli. Riprova più tardi.</p>
          </div>
          {refresh}
        </>
      ) : (
        <>
          <p className="text-sm text-zinc-600">
            {result.jobs.length === 1 ? "1 corsa adatta ai tuoi veicoli." : `${result.jobs.length} corse adatte ai tuoi veicoli.`} Gli indirizzi
            completi e i contatti sono visibili dopo l&apos;accettazione.
          </p>
          <ul className="space-y-3">
            {result.jobs.map((job) => (
              <li key={job.orderId}>
                <JobListCard job={job} href={JOB_PATHS.available_job(job.orderId)} />
              </li>
            ))}
          </ul>
          {refresh}
        </>
      )}
    </div>
  );
}
