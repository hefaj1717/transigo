"use client";

import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { releaseJobAction } from "@/app/(padroncino)/padroncino/corse/actions";
import { JOB_MSG } from "@/lib/carriers/jobs";
import { bigButtonSecondary } from "./carrier-shell";

// "Rinuncia alla corsa" (D121): the deadline is shown BEFORE the button (Europe/Rome, prepared on the server),
// a confirmation sheet says clearly that the job goes back to the other carriers, the confirm button is
// disabled with a label while the action runs (plus a ref guard against a double tap), and on success the
// carrier goes back to "Le mie corse" with a notice. The database (release_job) always decides: when the
// deadline passed in the meantime (too_late) the box turns into the same "Contatta Transigo" text as after
// the deadline — `expired` is rendered by the server and passed in, so both cases look the same.

export function ReleaseJob({
  orderId,
  orderNumber,
  deadlineLabel,
  expired,
}: {
  orderId: string;
  orderNumber: string;
  deadlineLabel: string;
  expired: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tooLate, setTooLate] = useState(false);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus(); // the safe choice gets the focus
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending.current) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function confirm() {
    if (sending.current) return;
    sending.current = true;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("orderId", orderId);
      try {
        const r = await releaseJobAction(null, fd);
        if (r.ok) {
          router.push(r.href);
          return; // keep the button disabled until "Le mie corse" shows
        }
        setOpen(false);
        sending.current = false;
        if (r.tooLate) {
          setTooLate(true);
          router.refresh(); // the server now renders the expired box as well
          return;
        }
        setError(r.error);
        if (r.error === JOB_MSG.notAssigned) router.refresh();
      } catch {
        setError(JOB_MSG.generic);
        setOpen(false);
        sending.current = false;
      }
    });
  }

  if (tooLate) return <>{expired}</>;

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">Rinuncia</h2>
      <p className="mt-2 font-medium text-zinc-900">{deadlineLabel}</p>
      <p className="mt-1 text-sm text-zinc-600">Dopo questo termine potrai solo contattare Transigo.</p>
      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        disabled={pending}
        className={`${bigButtonSecondary} mt-3 border-red-300 text-red-700 active:bg-red-50`}
      >
        Rinuncia alla corsa
      </button>

      {open ? (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => !sending.current && setOpen(false)}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-xl sm:rounded-3xl"
          >
            <h2 id={titleId} className="text-xl font-semibold text-zinc-900">
              Rinunci alla corsa {orderNumber}?
            </h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-zinc-700">
              <li>La corsa non sarà più tua e <strong>tornerà disponibile per gli altri padroncini</strong>.</li>
              <li>Non vedrai più indirizzi e contatti di questa corsa.</li>
              <li>Il team Transigo riceverà un avviso della tua rinuncia.</li>
            </ul>
            <div className="mt-5 space-y-3">
              <button
                type="button"
                onClick={confirm}
                disabled={pending}
                aria-busy={pending}
                className="flex min-h-12 w-full items-center justify-center rounded-xl bg-red-700 px-5 text-base font-semibold text-white active:bg-red-800 disabled:opacity-60"
              >
                {pending ? "Rinuncia in corso…" : "Sì, rinuncio alla corsa"}
              </button>
              <button ref={cancelRef} type="button" onClick={() => setOpen(false)} disabled={pending} className={bigButtonSecondary}>
                No, tengo la corsa
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
