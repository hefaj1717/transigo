import Link from "next/link";
import { bigButton, bigButtonSecondary } from "@/components/padroncino/carrier-shell";
import { SubmitForReview } from "@/components/padroncino/submit-for-review";
import { canEditOnboarding, CARRIER_PATHS, carrierOnboarding, describeMissing } from "@/lib/carriers/onboarding";
import { CARRIER_DOCUMENT_TYPES } from "@/lib/carriers/document-types";
import { loadCarrier, loadVehicles } from "@/lib/carriers/pages";
import { createClient } from "@/lib/supabase/server";
import { countMyJobs, JOB_PATHS } from "@/lib/carriers/jobs";
import { loadMyJobs } from "@/lib/carriers/jobs-server";

// Carrier home while the account is not active (D99–D101, D108, D109, D112). Reads with the carrier's own
// session; what is missing comes from carrier_onboarding_missing().
export async function OnboardingHome({ userId }: { userId: string }) {
  const db = await createClient();
  const [{ carrier, view }, vehicles, missingResult] = await Promise.all([
    loadCarrier(db, userId),
    loadVehicles(db, userId),
    db.rpc("carrier_onboarding_missing", { p_carrier_id: userId }),
  ]);
  if (!carrier) {
    return <Notice tone="red" title="Account non trovato">Non troviamo i dati del tuo account. Contatta l&apos;assistenza Transigo.</Notice>;
  }
  if (missingResult.error) console.error("[carriers] carrier_onboarding_missing failed", { code: missingResult.error.code });
  const missing = (missingResult.data as string[] | null) ?? [];
  const checkFailed = !!missingResult.error;

  const onboarding = carrierOnboarding({
    view,
    missing,
    statusReason: carrier.status_reason,
    submittedAt: carrier.submitted_at,
    phoneVerified: !!carrier.phone_verified_at,
    stripePayoutsEnabled: carrier.stripe_payouts_enabled,
  });

  if (view === "suspended") {
    // D116: jobs accepted before the suspension stay with the carrier (and may be released) — show them.
    const myJobs = await loadMyJobs(db, userId).catch(() => null);
    const counts = myJobs ? countMyJobs(myJobs) : null;
    const open = counts ? counts["da-fare"] + counts["in-corso"] : null;
    return (
      <div className="space-y-4">
        <Notice tone="red" title="Account sospeso">{onboarding.notice}</Notice>
        <Link href={JOB_PATHS.mine} className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-4 active:bg-zinc-50">
          <span>
            <span className="block font-semibold text-zinc-900">Le mie corse</span>
            <span className="block text-sm text-zinc-600">
              {open === null
                ? "Apri le corse che hai già accettato."
                : open === 0
                  ? "Nessuna corsa da fare o in corso."
                  : `${open === 1 ? "1 corsa" : `${open} corse`} da fare o in corso: restano assegnate a te.`}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {open !== null ? <span className="min-w-8 rounded-full bg-[#0B3B8C] px-2 text-center text-sm leading-7 font-semibold text-white">{open}</span> : null}
            <span aria-hidden className="text-[#0B3B8C]">→</span>
          </span>
        </Link>
        <p className="text-sm text-zinc-700">
          Se la sospensione riguarda un documento scaduto o mancante, carica la versione aggiornata: il team Transigo la verificherà e deciderà sulla riattivazione.
        </p>
        <Link href={CARRIER_PATHS.documents} className={bigButton}>Carica documenti aggiornati</Link>
        <Link href={CARRIER_PATHS.vehicles} className={bigButtonSecondary}>Documenti dei veicoli</Link>
      </div>
    );
  }

  if (view === "in_review") {
    return (
      <div className="space-y-4">
        <Notice tone="blue" title="Account in verifica">{onboarding.notice}</Notice>
        <p className="text-sm text-zinc-700">Fino alla decisione non puoi modificare i dati. Puoi consultarli qui:</p>
        <SectionLinks />
      </div>
    );
  }

  const items = describeMissing(missing, vehicles);
  const editable = canEditOnboarding(view);
  return (
    <div className="space-y-5">
      {view === "rejected" ? (
        <Notice tone="red" title="Registrazione non approvata">{onboarding.notice}</Notice>
      ) : (
        <Notice tone="amber" title="Registrazione incompleta">
          Completa i passaggi qui sotto e invia i dati per la verifica. Il team Transigo attiverà l&apos;account dopo il controllo.
        </Notice>
      )}

      <ul className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 bg-white">
        {onboarding.items.map((item) => {
          const done = checkFailed && item.key !== "approval" ? false : item.done;
          const label = (
            <>
              {item.label}
              <span className="sr-only">{done ? " (completato)" : " (da completare)"}</span>
            </>
          );
          return (
            <li key={item.key} className="flex min-h-12 items-center gap-3 px-4 py-2 text-sm">
              <span aria-hidden className={done ? "text-green-700" : "text-zinc-400"}>{done ? "✓" : "○"}</span>
              <span className="flex-1">
                {item.href ? <Link href={item.href} className="font-medium text-[#0B3B8C] underline">{label}</Link> : <span className="text-zinc-900">{label}</span>}
                {!done && item.comingSoon ? <span className="ml-2 text-xs text-zinc-500">disponibile a breve</span> : null}
              </span>
            </li>
          );
        })}
      </ul>

      {items.length ? (
        <div className="text-sm">
          <h2 className="font-semibold text-zinc-900">Cosa manca</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {items.map((i) => <li key={i.code}><Link href={i.href} className="text-[#0B3B8C] underline">{i.label}</Link></li>)}
          </ul>
        </div>
      ) : null}

      {editable ? (
        <SubmitForReview
          canSubmit={onboarding.canSubmit && !checkFailed}
          resubmit={view === "rejected"}
          describe={Object.fromEntries(describeMissing(allCodes(vehicles), vehicles).map((i) => [i.code, i]))}
        />
      ) : null}
    </div>
  );
}

/** Every code the submit error can return (D99), so the button can link them without another request. */
function allCodes(vehicles: { id: string }[]): string[] {
  const required = CARRIER_DOCUMENT_TYPES.filter((t) => t.isRequired);
  return [
    "company",
    "vehicle",
    ...required.filter((t) => t.scope === "carrier").map((t) => `document:${t.docType}`),
    ...vehicles.flatMap((v) => required.filter((t) => t.scope === "vehicle").map((t) => `vehicle_document:${v.id}:${t.docType}`)),
  ];
}

function SectionLinks() {
  return (
    <div className="space-y-3">
      <Link href={CARRIER_PATHS.company} className={bigButtonSecondary}>Dati aziendali</Link>
      <Link href={CARRIER_PATHS.vehicles} className={bigButtonSecondary}>Veicoli</Link>
      <Link href={CARRIER_PATHS.documents} className={bigButtonSecondary}>Documenti aziendali</Link>
    </div>
  );
}

const TONES = {
  amber: "border-amber-300 bg-amber-50 text-amber-900",
  red: "border-red-300 bg-red-50 text-red-900",
  blue: "border-blue-300 bg-blue-50 text-blue-900",
} as const;

function Notice({ tone, title, children }: { tone: keyof typeof TONES; title: string; children: React.ReactNode }) {
  return (
    <section className={`rounded-xl border p-4 ${TONES[tone]}`}>
      <h2 className="text-lg font-semibold">{title}</h2>
      {children ? <p className="mt-1 text-sm">{children}</p> : null}
    </section>
  );
}

