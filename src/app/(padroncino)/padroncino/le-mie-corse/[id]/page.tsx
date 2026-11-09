import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Loading } from "@/components/panel-shell";
import { bigButton, bigButtonSecondary, CarrierShell } from "@/components/padroncino/carrier-shell";
import { JobAmount, JobFacts, Notice, Section } from "@/components/padroncino/job-views";
import { RefreshButton } from "@/components/padroncino/refresh-button";
import { requireArea } from "@/lib/auth/session";
import { JOB_MSG, JOB_PATHS } from "@/lib/carriers/jobs";
import { loadMyJob, type MyJobDetail } from "@/lib/carriers/jobs-server";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "La mia corsa – Transigo" };

const back = { href: JOB_PATHS.mine, label: "Le mie corse" };

// An own job (assigned to this carrier, RLS + carrier_id filter): full data — addresses, contacts, notes.
// Step 4a: the confirmation after "Accetta la Corsa" (?esito=) and the full job. Step 4b adds the "Rinuncia"
// box with its deadline and the rest of "Le mie corse".
export default function Page({ params, searchParams }: PageProps<"/padroncino/le-mie-corse/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const ESITO: Record<string, string> = { accettata: JOB_MSG.accepted, "gia-tua": JOB_MSG.alreadyMine };

async function Content({ params, searchParams }: Pick<PageProps<"/padroncino/le-mie-corse/[id]">, "params" | "searchParams">) {
  const { id } = await params;
  const esito = (await searchParams).esito;
  const ctx = await requireArea("padroncino", JOB_PATHS.my_job(id));

  let job: MyJobDetail | null;
  try {
    job = await loadMyJob(await createClient(), ctx.userId, id);
  } catch {
    return (
      <CarrierShell title="La mia corsa" back={back}>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p role="alert" className="font-medium text-red-800">Non è stato possibile caricare la corsa.</p>
          <div className="mt-4">
            <RefreshButton label="Riprova" pendingLabel="Caricamento…" className={bigButton} />
          </div>
        </div>
      </CarrierShell>
    );
  }
  if (!job) notFound();

  const confirmation = typeof esito === "string" ? ESITO[esito] : undefined;
  const contacts = [
    { title: "Contatto per il ritiro", c: job.pickupContact },
    { title: "Contatto per la consegna", c: job.deliveryContact },
  ];

  return (
    <CarrierShell title={`Corsa ${job.orderNumber}`} back={back}>
      <div className="space-y-4">
        {confirmation ? <Notice tone="success">{confirmation}</Notice> : null}

        <p>
          <span className="rounded-full bg-blue-100 px-3 py-1 text-sm font-semibold text-[#0B3B8C]">{job.statusLabel}</span>
        </p>

        <Section title="Indirizzi">
          <ol className="space-y-3 text-sm">
            {job.addresses.map((a) => {
              return (
                <li key={a.legIndex} className="space-y-2">
                  {job.addresses.length > 1 ? <p className="font-semibold text-zinc-900">Tratta {a.legIndex + 1}</p> : null}
                  <p>
                    <span className="block text-zinc-500">Ritiro</span>
                    <span className="break-words text-zinc-900">
                      {a.pickupAddress}
                    </span>
                  </p>
                  <p>
                    <span className="block text-zinc-500">Consegna</span>
                    <span className="break-words text-zinc-900">
                      {a.deliveryAddress}
                    </span>
                  </p>
                </li>
              );
            })}
          </ol>
        </Section>

        <Section title="Contatti">
          <ul className="space-y-3 text-sm">
            {contacts.map(({ title, c }) => (
              <li key={title}>
                <span className="block text-zinc-500">{title}</span>
                <span className="block break-words text-zinc-900">{c.name}</span>
                <a href={`tel:${c.phone.replace(/\s+/g, "")}`} className="inline-flex min-h-11 items-center font-semibold text-[#0B3B8C] underline">
                  {c.phone}
                </a>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Merce e note">
          <p className="text-sm break-words whitespace-pre-line">{job.goodsDescription}</p>
          {job.goodsDimensionsNote ? <p className="mt-2 text-sm break-words whitespace-pre-line text-zinc-600">{job.goodsDimensionsNote}</p> : null}
          {job.customerNotes ? (
            <p className="mt-2 text-sm break-words whitespace-pre-line">
              <span className="block text-zinc-500">Note del cliente</span>
              {job.customerNotes}
            </p>
          ) : null}
          {job.vehicle ? (
            <p className="mt-2 text-sm">
              <span className="text-zinc-500">Veicolo: </span>
              {job.vehicle.vehicleTypeName} · {job.vehicle.plate}
            </p>
          ) : null}
        </Section>

        <JobAmount amount={job.amount} />
        <JobFacts job={job} />

        <Link href={JOB_PATHS.available} className={bigButtonSecondary}>Torna alle corse disponibili</Link>
      </div>
    </CarrierShell>
  );
}
