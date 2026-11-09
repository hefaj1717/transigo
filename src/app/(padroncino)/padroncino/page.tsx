import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { bigButton, bigButtonSecondary, CarrierShell } from "@/components/padroncino/carrier-shell";
import { requireArea } from "@/lib/auth/session";
import { carrierPanelView } from "@/lib/auth/routing";
import { countMyJobs, JOB_PATHS, myJobsHref } from "@/lib/carriers/jobs";
import { listAvailableJobs, loadMyJobs } from "@/lib/carriers/jobs-server";
import { createClient } from "@/lib/supabase/server";
import { CARRIER_PATHS } from "@/lib/carriers/onboarding";
import { OnboardingHome } from "./onboarding-home";

export const metadata = { title: "Area padroncino – Transigo" };

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const ctx = await requireArea("padroncino", "/padroncino");
  const greeting = `Ciao${ctx.firstName ? `, ${ctx.firstName}` : ""}!`;

  if (carrierPanelView(ctx) === "pending") {
    return (
      <CarrierShell title={greeting}>
        <OnboardingHome userId={ctx.userId} />
      </CarrierShell>
    );
  }
  return (
    <CarrierShell title={greeting}>
      <p>Il tuo account è attivo.</p>
      <div className="mt-4">
        <Suspense fallback={<CountersSkeleton />}>
          <ActiveCounters userId={ctx.userId} />
        </Suspense>
      </div>
      <div className="mt-6 space-y-3">
        <Link href={JOB_PATHS.available} className={bigButton}>Vedi le corse disponibili</Link>
        <Link href={CARRIER_PATHS.vehicles} className={bigButtonSecondary}>I miei veicoli</Link>
        <Link href={CARRIER_PATHS.documents} className={bigButtonSecondary}>Documenti aziendali</Link>
      </div>
    </CarrierShell>
  );
}

/**
 * Two tiles: available jobs and "Da fare". Each one is read on its own (carrier's session); a failed read shows
 * "—" instead of breaking the page. Blocked carriers (e.g. expired document) see "Da sistemare" on the first tile.
 */
async function ActiveCounters({ userId }: { userId: string }) {
  const db = await createClient();
  const [available, mine] = await Promise.all([
    listAvailableJobs(db).catch(() => null),
    loadMyJobs(db, userId).catch(() => null),
  ]);
  const toDo = mine ? countMyJobs(mine)["da-fare"] : null;
  const inProgress = mine ? countMyJobs(mine)["in-corso"] : 0;
  return (
    <div className="grid grid-cols-2 gap-3">
      <CounterTile
        href={JOB_PATHS.available}
        value={available === null ? "—" : available.ok ? String(available.jobs.length) : "!"}
        label={available !== null && !available.ok ? "Da sistemare per ricevere corse" : "Corse disponibili"}
      />
      <CounterTile href={JOB_PATHS.mine} value={toDo === null ? "—" : String(toDo)} label="Da fare" />
      {inProgress > 0 ? (
        <div className="col-span-2">
          <CounterTile href={myJobsHref({ tab: "in-corso" })} value={String(inProgress)} label={inProgress === 1 ? "Corsa in corso" : "Corse in corso"} wide />
        </div>
      ) : null}
    </div>
  );
}

function CounterTile({ href, value, label, wide }: { href: string; value: string; label: string; wide?: boolean }) {
  return (
    <Link
      href={href}
      className={`flex min-h-24 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm active:bg-zinc-50 ${wide ? "items-center gap-3" : "flex-col justify-between"}`}
    >
      <span className="text-3xl font-bold text-[#0B3B8C]">{value}</span>
      <span className="text-sm font-medium text-zinc-800">
        {label} <span aria-hidden className="text-[#0B3B8C]">→</span>
      </span>
    </Link>
  );
}

function CountersSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3" aria-hidden>
      <div className="min-h-24 animate-pulse rounded-2xl bg-zinc-200" />
      <div className="min-h-24 animate-pulse rounded-2xl bg-zinc-200" />
    </div>
  );
}
