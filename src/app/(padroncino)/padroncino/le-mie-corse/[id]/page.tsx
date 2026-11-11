import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { bigButton, bigButtonSecondary, CarrierShell } from "@/components/padroncino/carrier-shell";
import { ContactTransigo, JobAmount, Notice, RouteList, Section, UrgentBadge } from "@/components/padroncino/job-views";
import { RefreshButton } from "@/components/padroncino/refresh-button";
import { JobExecution } from "@/components/padroncino/execution/job-execution";
import { legStops } from "@/components/padroncino/execution/leg-stops";
import { ReleaseJob } from "@/components/padroncino/release-job";
import { requireArea } from "@/lib/auth/session";
import {
  formatDuration,
  formatKm,
  JOB_MSG,
  JOB_PATHS,
  myJobsHref,
  RELEASE_EXPIRED_TEXT,
  romeDateTime,
  romeWindow,
  type RouteStop,
} from "@/lib/carriers/jobs";
import { EXEC_MSG, isJobRunning } from "@/lib/carriers/execution";
import { googleMapsUrl } from "@/lib/carriers/execution-ui";
import { loadJobExecution, type ExecutionView } from "@/lib/carriers/execution-server";
import { loadMyJob, type MyJobDetail } from "@/lib/carriers/jobs-server";
import { getCompanyInfo } from "@/lib/public/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const metadata = { title: "La mia corsa – Transigo" };

// An own job (assigned to this carrier, RLS + carrier_id filter): full data — addresses with "Apri in Maps",
// floors, contacts (tel:), goods, services, notes, the amount, the status history — and "Rinuncia alla corsa"
// while status is 'assigned' (D121): the deadline in Europe/Rome before the button; after it (or when
// release_job answers too_late) "Contatta Transigo" instead of the button. ?esito= after "Accetta la Corsa".
// Facchinaggio (D164, D165): one place (address, floor, on-site contact), the team, no vehicle and no execution
// steps in the app yet — the admin records "Lavoro iniziato" / "Lavoro concluso".
export default function Page({ params, searchParams }: PageProps<"/padroncino/le-mie-corse/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const ESITO: Record<string, string> = { accettata: JOB_MSG.accepted, "gia-tua": JOB_MSG.alreadyMine, consegnata: EXEC_MSG.delivered };




async function Content({ params, searchParams }: Pick<PageProps<"/padroncino/le-mie-corse/[id]">, "params" | "searchParams">) {
  const { id } = await params;
  const esito = (await searchParams).esito;
  const ctx = await requireArea("padroncino", JOB_PATHS.my_job(id));

  let job: MyJobDetail | null;
  try {
    job = await loadMyJob(await createClient(), ctx.userId, id);
  } catch {
    return (
      <CarrierShell title="La mia corsa" back={{ href: JOB_PATHS.mine, label: "Le mie corse" }}>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p role="alert" className="font-medium text-red-800">Non è stato possibile caricare la corsa.</p>
          <div className="mt-4">
            <RefreshButton label="Riprova" pendingLabel="Caricamento…" className={bigButton} />
          </div>
        </div>
      </CarrierShell>
    );
  }
  // Not (or no longer) this carrier's job — e.g. an old link after "Rinuncia" or "Rimuovi padroncino". RLS returns
  // nothing, so there is nothing to leak: an Italian notice instead of the framework's English 404.
  if (!job) return <NotMine />;

  const back = { href: myJobsHref({ tab: job.tab }), label: "Le mie corse" };
  const confirmation = typeof esito === "string" ? ESITO[esito] : undefined;
  const company = job.release.allowed || job.release.reason === "expired" ? await getCompanyInfo() : null;
  const expiredBox = company ? <ContactTransigo text={RELEASE_EXPIRED_TEXT} phone={company.phone} email={company.email} /> : null;

  const lastLeg = job.legs.length - 1;

  // Running (or delivered) job: the execution state, read with the carrier's session (D130).
  let execution: ExecutionView | null = null;
  let executionFailed = false;
  if (!job.porters && (isJobRunning(job.status) || job.status === "delivered" || job.status === "completed")) {
    try {
      execution = await loadJobExecution(await createClient(), ctx.userId, id, { serviceDb: () => createServiceClient() });
    } catch {
      executionFailed = true;
    }
  }

  return (
    <CarrierShell title={job.porters ? `Facchinaggio ${job.orderNumber}` : `Corsa ${job.orderNumber}`} back={back}>
      <div className="space-y-4">
        {confirmation ? <Notice tone="success">{confirmation}</Notice> : null}

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-blue-100 px-3 py-1 text-sm font-semibold text-[#0B3B8C]">{job.statusLabel}</span>
          {job.isUrgent ? <UrgentBadge /> : null}
        </div>

        {executionFailed ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
            <p role="alert" className="font-medium text-red-800">Non è stato possibile caricare i passaggi della corsa.</p>
            <div className="mt-3">
              <RefreshButton label="Riprova" pendingLabel="Caricamento…" className={bigButton} />
            </div>
          </div>
        ) : null}
        {execution && isJobRunning(execution.status) ? (
          <JobExecution view={execution} stops={legStops(job)} podHref={JOB_PATHS.my_job_delivery(job.orderId)} />
        ) : null}
        {execution?.proof ? (
          <Notice tone="success">
            Consegnata a {execution.proof.recipientName} il {romeDateTime(execution.proof.signedAt)}.
          </Notice>
        ) : null}

        {job.porters ? (
          <>
            {job.status === "assigned" || job.status === "picked_up" ? (
              <Notice tone="info">Lo stato del lavoro lo aggiorna Transigo: avvisaci quando inizi e quando finisci.</Notice>
            ) : null}
            <Stop
              title="Lavoro"
              when={romeWindow(job.pickupWindowStart, job.pickupWindowEnd)}
              stop={job.stops[0]}
              address={job.portersPlace?.address ?? null}
              postalCode={null}
              lat={job.portersPlace?.lat}
              lng={job.portersPlace?.lng}
              floor={job.porters.floor}
              contact={job.pickupContact.name ? job.pickupContact : null}
              extra={<Row label="Squadra">{job.porters.persons} facchini · {job.porters.hours} h di lavoro</Row>}
            />
          </>
        ) : null}

        {job.porters ? null : <Section title="Percorso">
          <RouteList stops={job.stops} />
          <p className="mt-3 text-sm text-zinc-600">
            {formatKm(job.distanceM)} · {formatDuration(job.durationS)} di guida (stima)
          </p>
        </Section>}

        {job.legs.map((leg, i) => {
          const addr = job.addresses.find((a) => a.legIndex === leg.legIndex);
          const multi = job.legs.length > 1;
          return (
            <div key={leg.legIndex} className="space-y-4">
              {multi ? <h2 className="pt-1 text-lg font-semibold text-zinc-900">Tratta {leg.legIndex + 1}</h2> : null}
              <Stop
                title="Ritiro"
                when={romeWindow(leg.pickupWindowStart, leg.pickupWindowEnd)}
                stop={leg.from}
                address={addr?.pickupAddress ?? null}
                postalCode={addr?.pickupPostalCode ?? null}
                lat={addr?.pickupLat}
                lng={addr?.pickupLng}
                floor={leg.pickupFloor}
                contact={i === 0 && !leg.from.isWarehouse ? job.pickupContact : null}
              />
              <Stop
                title="Consegna"
                stop={leg.to}
                address={addr?.deliveryAddress ?? null}
                postalCode={addr?.deliveryPostalCode ?? null}
                lat={addr?.deliveryLat}
                lng={addr?.deliveryLng}
                floor={leg.deliveryFloor}
                contact={i === lastLeg && !leg.to.isWarehouse ? job.deliveryContact : null}
                extra={<Row label="Distanza">{formatKm(leg.distanceM)} · {formatDuration(leg.durationS)}</Row>}
              />
            </div>
          );
        })}

        <Section title={job.porters ? "Cosa spostare" : "Merce e servizi"}>
          <dl className="space-y-2 text-sm">
            <Row label={job.porters ? "Descrizione" : "Merce"}>
              <span className="whitespace-pre-line">{job.goodsDescription}</span>
              {job.goodsDimensionsNote ? <span className="mt-1 block whitespace-pre-line text-zinc-600">{job.goodsDimensionsNote}</span> : null}
            </Row>
            {job.load.length ? <Row label="Carico">{job.load.join(" · ")}</Row> : null}
            <Row label="Servizi">
              {job.services.length ? (
                <ul className="space-y-0.5">
                  {job.services.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              ) : (
                "Solo trasporto"
              )}
            </Row>
            {job.porters ? null : <Row label="Veicolo">{job.vehicle ? `${job.vehicle.vehicleTypeName} · ${job.vehicle.plate}` : job.vehicleTypeName}</Row>}
          </dl>
        </Section>

        {job.customerNotes ? (
          <Section title="Note del cliente">
            <p className="text-sm break-words whitespace-pre-line">{job.customerNotes}</p>
          </Section>
        ) : null}

        <JobAmount amount={job.amount} />

        <Section title="Storico">
          <dl className="space-y-2 text-sm">
            {(
              (job.porters
                ? [
                    ["Accettato", job.times.assignedAt],
                    ["Lavoro iniziato", job.times.pickedUpAt],
                    ["Lavoro concluso", job.times.deliveredAt],
                    ["Completato", job.times.completedAt],
                  ]
                : [
                    ["Accettata", job.times.assignedAt],
                    ["Ritirata", job.times.pickedUpAt],
                    ["In viaggio", job.times.inTransitAt],
                    ["Consegnata", job.times.deliveredAt],
                    ["Completata", job.times.completedAt],
                  ]) as [string, string | null][]
            )
              .filter(([, t]) => t)
              .map(([label, t]) => (
                <Row key={label} label={label}>
                  {romeDateTime(t as string)}
                </Row>
              ))}
          </dl>
        </Section>

        {job.release.allowed ? (
          <ReleaseJob orderId={job.orderId} orderNumber={job.orderNumber} deadlineLabel={job.release.label} expired={expiredBox} />
        ) : job.release.reason === "expired" ? (
          expiredBox
        ) : null}

        <Link href={back.href} className={bigButtonSecondary}>
          Torna a «Le mie corse»
        </Link>
      </div>
    </CarrierShell>
  );
}

/** Shown for any id that is not the carrier's job (released, reassigned, someone else's, malformed). */
function NotMine() {
  return (
    <CarrierShell title="Corsa non disponibile" back={{ href: JOB_PATHS.mine, label: "Le mie corse" }}>
      <div className="space-y-4">
        <Notice tone="info">{JOB_MSG.notAssigned}</Notice>
        <Link href={JOB_PATHS.mine} className={bigButtonSecondary}>
          Torna a «Le mie corse»
        </Link>
      </div>
    </CarrierShell>
  );
}


function Stop({
  title,
  when,
  stop,
  address,
  postalCode,
  lat,
  lng,
  floor,
  contact,
  extra,
}: {
  title: string;
  when?: string;
  stop: RouteStop;
  address: string | null;
  postalCode: string | null;
  lat?: number;
  lng?: number;
  floor: string | null;
  contact: { name: string; phone: string } | null;
  extra?: ReactNode;
}) {
  const showCap = postalCode && address && !address.includes(postalCode);
  return (
    <Section title={title}>
      <dl className="space-y-2 text-sm">
        {when ? <Row label="Quando"><span className="first-letter:uppercase">{when}</span></Row> : null}
        <Row label="Indirizzo">
          {stop.isWarehouse ? <span className="block font-medium">Magazzino Transigo</span> : null}
          <span className="block font-medium text-zinc-900">{address ?? "—"}</span>
          {showCap ? <span className="block">{postalCode}</span> : null}
          {!address?.includes(stop.city) ? (
            <span className="block text-zinc-500">
              {stop.city} ({stop.province})
            </span>
          ) : null}
        </Row>
        {floor ? <Row label="Piano">{floor}</Row> : null}
        {contact ? (
          <Row label="Contatto">
            <span className="block">{contact.name}</span>
            <a href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`} className="inline-flex min-h-11 items-center font-semibold text-[#0B3B8C] underline">
              Chiama {contact.phone}
            </a>
          </Row>
        ) : null}
        {extra}
      </dl>
      {typeof lat === "number" && typeof lng === "number" ? (
        <a href={googleMapsUrl(lat, lng)} target="_blank" rel="noopener noreferrer" className={`${bigButtonSecondary} mt-3`}>
          Apri in Google Maps
        </a>
      ) : null}
    </Section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
