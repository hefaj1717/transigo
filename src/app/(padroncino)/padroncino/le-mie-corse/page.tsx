import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { bigButton, bigButtonSecondary, CarrierShell } from "@/components/padroncino/carrier-shell";
import { JobListCard, MyJobTabs, Notice } from "@/components/padroncino/job-views";
import { RefreshButton } from "@/components/padroncino/refresh-button";
import { requireArea } from "@/lib/auth/session";
import {
  countMyJobs,
  JOB_PATHS,
  jobsForTab,
  MY_JOB_TAB_EMPTY,
  MY_JOB_TABS,
  myJobsHref,
  myJobsNotice,
  parseMyJobTab,
} from "@/lib/carriers/jobs";
import { loadMyJobs, type MyJobSummary } from "@/lib/carriers/jobs-server";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Le mie corse – Transigo" };

// "Le mie corse": tabs Da fare (assigned) / In corso (picked_up, in_transit) / Concluse (delivered, completed)
// with counters, an Italian empty state per tab, and the notice after "Rinuncia" (?esito=rinuncia — only
// whitelisted keys). Read with the carrier's own session (RLS); a suspended carrier sees its jobs too (D116).
export default function Page({ searchParams }: PageProps<"/padroncino/le-mie-corse">) {
  return (
    <CarrierShell title="Le mie corse">
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </CarrierShell>
  );
}

async function Content({ searchParams }: Pick<PageProps<"/padroncino/le-mie-corse">, "searchParams">) {
  const ctx = await requireArea("padroncino", JOB_PATHS.mine);
  const sp = await searchParams;
  const tab = parseMyJobTab(sp.tab);
  const notice = myJobsNotice(sp.esito);

  let jobs: MyJobSummary[];
  try {
    jobs = await loadMyJobs(await createClient(), ctx.userId);
  } catch {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
        <p role="alert" className="font-medium text-red-800">Non è stato possibile caricare le tue corse.</p>
        <p className="mt-1 text-sm text-red-800">Controlla la connessione e riprova.</p>
        <div className="mt-4">
          <RefreshButton label="Riprova" pendingLabel="Caricamento…" className={bigButton} />
        </div>
      </div>
    );
  }

  const counts = countMyJobs(jobs);
  const shown = jobsForTab(jobs, tab);
  const empty = MY_JOB_TAB_EMPTY[tab];

  return (
    <div className="space-y-4">
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <MyJobTabs
        tabs={MY_JOB_TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key], href: myJobsHref({ tab: t.key }), current: t.key === tab }))}
      />

      {shown.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-center">
          <p className="font-medium text-zinc-900">{empty.title}</p>
          <p className="mt-1 text-sm text-zinc-600">{empty.text}</p>
          {tab === "da-fare" && ctx.carrierStatus === "active" ? (
            <Link href={JOB_PATHS.available} className={`${bigButtonSecondary} mt-4`}>
              Vedi le corse disponibili
            </Link>
          ) : null}
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((job) => (
            <li key={job.orderId}>
              <p className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{job.statusLabel}</p>
              <JobListCard job={job} href={JOB_PATHS.my_job(job.orderId)} />
            </li>
          ))}
        </ul>
      )}

      <RefreshButton label="Aggiorna" pendingLabel="Aggiornamento…" href={myJobsHref({ tab })} className={bigButtonSecondary} />
    </div>
  );
}
