"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { recordStepAction } from "@/app/(padroncino)/padroncino/le-mie-corse/[id]/actions";
import { currentPosition } from "@/lib/browser/upload-with-progress";
import { EXEC_MSG, isInWarehouse, nextAction, type LegStep } from "@/lib/carriers/execution";
import { stepButtonState } from "@/lib/carriers/execution-ui";
import type { ExecutionView } from "@/lib/carriers/execution-server";
import { bigButton, stickyActionBar } from "../carrier-shell";
import { ConfirmSheet } from "./confirm-sheet";
import { PhotoStep } from "./photo-step";
import { PorterTime } from "./porter-time";
import { StepTimeline } from "./step-timeline";
import { StopCard, type StopInfo } from "./stop-card";
import { usePhotoUploads } from "./use-photo-uploads";

export type LegStops = { legIndex: number; pickup: StopInfo; delivery: StopInfo };

const CONFIRM_TEXT: Partial<Record<LegStep, { title: string; body: string }>> = {
  loaded: {
    title: "Carico completato?",
    body: "Dopo la conferma le foto del carico non si possono più cambiare e il cliente vedrà la merce come ritirata.",
  },
  unloaded: {
    title: "Scarico completato?",
    body: "Dopo la conferma le foto della consegna non si possono più cambiare.",
  },
};

/**
 * Running job (D130): current stop, the photos of the open step, the steps done, and ONE big button with the next
 * step at the bottom (thumb reach). "Carico/Scarico completato" ask in an in-app sheet; the other steps go with one
 * tap. Double taps are blocked (ref + disabled); the database decides anyway (a repeated step is a no-op).
 */
export function JobExecution({ view, stops, podHref }: { view: ExecutionView; stops: readonly LegStops[]; podHref: string }) {
  const router = useRouter();
  const savedPaths = useMemo(() => view.photos.map((p) => p.path), [view.photos]);
  const photos = usePhotoUploads(view.orderId, savedPaths);
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);

  const next = nextAction({ status: view.status, legs: view.legs, steps: view.steps });
  const inWarehouse = isInWarehouse(view.legs, view.steps);

  const legStops = (legIndex: number) => stops.find((s) => s.legIndex === legIndex);
  let stop: StopInfo | undefined;
  if (next.kind === "step") {
    const s = legStops(next.legIndex);
    const atPickup = next.step === "arrived_pickup" || next.step === "loaded";
    stop = atPickup ? s?.pickup : s?.delivery;
    if (atPickup && stop && view.handover?.legIndex === next.legIndex) stop = { ...stop, handoverAddress: view.handover.address };
  } else if (next.kind === "pod") {
    stop = stops.at(-1)?.delivery;
  }

  const photoKind = next.kind === "step" ? next.photoKind : null;
  const saved = next.kind === "step" && photoKind ? view.photos.filter((p) => p.legIndex === next.legIndex && p.kind === photoKind) : [];
  const pending = next.kind === "step" && photoKind ? photos.queue.filter((p) => p.legIndex === next.legIndex && p.kind === photoKind) : [];
  const button = stepButtonState({ next, savedPhotos: saved.length, pending: photos.queue, submitting });

  async function send() {
    if (next.kind !== "step" || sending.current) return;
    sending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const pos = await currentPosition();
      const r = await recordStepAction({ orderId: view.orderId, legIndex: next.legIndex, step: next.step, lat: pos?.lat ?? null, lng: pos?.lng ?? null });
      if (!r.ok) setError(r.message);
      if (r.ok || r.refresh) router.refresh();
      setConfirmOpen(false);
    } catch {
      setError(EXEC_MSG.network);
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  const confirmText = next.kind === "step" ? CONFIRM_TEXT[next.step] : undefined;

  return (
    <div className="space-y-4">
      {inWarehouse ? (
        <p className="rounded-2xl bg-amber-50 p-3 text-sm font-medium text-amber-900">
          In magazzino: la merce è stata scaricata in magazzino. La tratta successiva inizia il giorno del ritiro.
        </p>
      ) : null}

      {/* At a photo step the carrier is already on the spot: the camera first, the address card after it. */}
      {next.kind === "step" && photoKind ? (
        <PhotoStep
          orderId={view.orderId}
          legIndex={next.legIndex}
          kind={photoKind}
          step={next.step}
          saved={saved}
          pending={pending}
          preview={photos.preview}
          onAdd={(file) => photos.add(file, next.legIndex, photoKind)}
          onRetry={photos.retry}
          onDiscard={photos.discard}
          disabled={submitting}
        />
      ) : null}

      {stop ? <StopCard stop={stop} /> : null}

      {next.kind === "pod" ? <PorterTime porters={view.porters} multiLeg={view.legs.length > 1} /> : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-zinc-900">Passaggi</h2>
        <StepTimeline legs={view.legs} steps={view.steps} />
      </section>

      {button.kind !== "hidden" ? (
        <div className={stickyActionBar}>
          {error ? (
            <div role="alert" className="mb-2 rounded-lg bg-red-50 p-2 text-sm text-red-800">
              {error}
              {next.kind === "step" ? (
                <button type="button" onClick={() => (button.kind === "ready" && button.confirm ? setConfirmOpen(true) : send())} className="ml-2 font-semibold underline">
                  Riprova
                </button>
              ) : null}
            </div>
          ) : null}
          {button.kind === "disabled" ? <p className="mb-2 text-center text-sm text-zinc-600">{button.reason}</p> : null}
          {next.kind === "pod" ? (
            <Link href={podHref} className={bigButton}>
              Conferma consegna
            </Link>
          ) : next.kind === "step" ? (
            <button
              type="button"
              disabled={button.kind !== "ready"}
              aria-busy={submitting}
              onClick={() => (button.kind === "ready" && button.confirm ? setConfirmOpen(true) : send())}
              className={bigButton}
            >
              {submitting ? "Invio in corso…" : next.label}
            </button>
          ) : null}
        </div>
      ) : null}

      <ConfirmSheet
        open={confirmOpen && !!confirmText}
        title={confirmText?.title ?? ""}
        confirmLabel="Sì, confermo"
        pendingLabel="Invio in corso…"
        pending={submitting}
        onConfirm={send}
        onCancel={() => setConfirmOpen(false)}
      >
        {confirmText?.body}
      </ConfirmSheet>
    </div>
  );
}
