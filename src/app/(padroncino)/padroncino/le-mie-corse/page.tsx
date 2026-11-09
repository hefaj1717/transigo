import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { bigButton, CarrierShell } from "@/components/padroncino/carrier-shell";
import { JobListCard } from "@/components/padroncino/job-views";
import { RefreshButton } from "@/components/padroncino/refresh-button";
import { requireArea } from "@/lib/auth/session";
import { JOB_PATHS } from "@/lib/carriers/jobs";
import { loadMyJobs, type MyJobSummary } from "@/lib/carriers/jobs-server";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Le mie corse – Transigo" };

// Step 4a: a plain list so the bottom navigation has a working target. Step 4b replaces it with the tabs
// "Da fare" / "In corso" / "Concluse" and counters.
export default function Page() {
  return (
    <CarrierShell title="Le mie corse">
      <Suspense fallback={<Loading />}>
        <Content />
      </Suspense>
    </CarrierShell>
  );
}

async function Content() {
  const ctx = await requireArea("padroncino", JOB_PATHS.mine);
  let jobs: MyJobSummary[];
  try {
    jobs = await loadMyJobs(await createClient(), ctx.userId);
  } catch {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
        <p role="alert" className="font-medium text-red-800">Non è stato possibile caricare le tue corse.</p>
        <div className="mt-4">
          <RefreshButton label="Riprova" pendingLabel="Caricamento…" className={bigButton} />
        </div>
      </div>
    );
  }
  if (jobs.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-center">
        <p className="font-medium text-zinc-900">Non hai ancora corse</p>
        <p className="mt-1 text-sm text-zinc-600">Le corse che accetti compaiono qui.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {jobs.map((job) => (
        <li key={job.orderId}>
          <p className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{job.statusLabel}</p>
          <JobListCard job={job} href={JOB_PATHS.my_job(job.orderId)} />
        </li>
      ))}
    </ul>
  );
}
