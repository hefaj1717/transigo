import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { bigButton, bigButtonSecondary, CarrierShell } from "@/components/padroncino/carrier-shell";
import { DeliveryForm } from "@/components/padroncino/execution/delivery-form";
import { Notice } from "@/components/padroncino/job-views";
import { RefreshButton } from "@/components/padroncino/refresh-button";
import { requireArea } from "@/lib/auth/session";
import { EXEC_MSG, nextAction } from "@/lib/carriers/execution";
import { loadJobExecution, type ExecutionView } from "@/lib/carriers/execution-server";
import { JOB_MSG, JOB_PATHS } from "@/lib/carriers/jobs";
import { loadMyJob, type MyJobDetail } from "@/lib/carriers/jobs-server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const metadata = { title: "Conferma consegna – Transigo" };

// "Conferma consegna" (POD, D130): only when every step is done (the database checks again in complete_delivery).
// Porter time before the signature, recipient name, finger signature — full screen for signing.
export default function Page({ params }: PageProps<"/padroncino/le-mie-corse/[id]/consegna">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: Pick<PageProps<"/padroncino/le-mie-corse/[id]/consegna">, "params">) {
  const { id } = await params;
  const ctx = await requireArea("padroncino", JOB_PATHS.my_job_delivery(id));
  const jobHref = JOB_PATHS.my_job(id);
  const back = { href: jobHref, label: "Torna alla corsa" };

  let job: MyJobDetail | null = null;
  let view: ExecutionView | null = null;
  try {
    const db = await createClient();
    job = await loadMyJob(db, ctx.userId, id);
    if (job) view = await loadJobExecution(db, ctx.userId, id, { serviceDb: () => createServiceClient() });
  } catch {
    return (
      <CarrierShell title="Conferma consegna" back={back}>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p role="alert" className="font-medium text-red-800">Non è stato possibile caricare la corsa.</p>
          <div className="mt-4">
            <RefreshButton label="Riprova" pendingLabel="Caricamento…" className={bigButton} />
          </div>
        </div>
      </CarrierShell>
    );
  }

  if (!job || !view) {
    return (
      <CarrierShell title="Corsa non disponibile" back={{ href: JOB_PATHS.mine, label: "Le mie corse" }}>
        <Notice tone="info">{JOB_MSG.notAssigned}</Notice>
      </CarrierShell>
    );
  }

  if (view.proof || nextAction({ status: view.status, legs: view.legs, steps: view.steps }).kind !== "pod") {
    return (
      <CarrierShell title={`Corsa ${job.orderNumber}`} back={back}>
        <div className="space-y-4">
          <Notice tone={view.proof ? "success" : "info"}>{view.proof ? EXEC_MSG.delivered : EXEC_MSG.stepsMissing}</Notice>
          <Link href={jobHref} className={bigButtonSecondary}>Torna alla corsa</Link>
        </div>
      </CarrierShell>
    );
  }

  return (
    <CarrierShell title="Conferma consegna" back={back}>
      <DeliveryForm
        orderId={job.orderId}
        orderNumber={job.orderNumber}
        contactName={job.legs.at(-1)?.to.isWarehouse ? null : job.deliveryContact.name}
        porters={view.porters}
        multiLeg={view.legs.length > 1}
        doneHref={`${jobHref}?esito=consegnata`}
      />
    </CarrierShell>
  );
}
