"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptJobAction } from "@/app/(padroncino)/padroncino/corse/actions";
import { JOB_MSG, JOB_PATHS, jobListNoticeKey } from "@/lib/carriers/jobs";
import { bigButton, bigButtonSecondary, stickyActionBar } from "./carrier-shell";

// "Accetta la Corsa" (D119, D120): vehicle choice (when more than one fits), sticky main button in thumb reach,
// a confirmation sheet (route, date, vehicle, amount) that can be closed without accepting, and a button that is
// disabled with a label while the action runs (plus a ref guard against a double tap).
//
// Props are display strings prepared on the server from the JobCard — no street, phone or customer name (D119).
// The carrier is the session's; the form sends only orderId + vehicleId (the Server Action validates both).

export type AcceptVehicle = { id: string; label: string };
export type AcceptSummary = { orderNumber: string; route: string; when: string; amount: string };

export function AcceptJob({ orderId, vehicles, summary }: { orderId: string; vehicles: AcceptVehicle[]; summary: AcceptSummary }) {
  const router = useRouter();
  const [vehicleId, setVehicleId] = useState<string | null>(vehicles.length === 1 ? vehicles[0].id : null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);

  const vehicle = vehicles.find((v) => v.id === vehicleId) ?? null;

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
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

  function openConfirm() {
    setError(null);
    if (!vehicle) {
      setError(JOB_MSG.chooseVehicle);
      return;
    }
    setOpen(true);
  }

  function confirm() {
    if (sending.current || !vehicle) return;
    sending.current = true;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("orderId", orderId);
      fd.set("vehicleId", vehicle.id);
      try {
        const r = await acceptJobAction(null, fd);
        if (r.ok) {
          router.push(`${r.href}?esito=${r.newlyAssigned ? "accettata" : "gia-tua"}`);
          return; // keep the button disabled until the next page shows
        }
        if (r.refreshList) {
          // The job is gone for this carrier (e.g. already_taken, D120): back to the refreshed list with the message.
          const key = jobListNoticeKey(r.error);
          router.push(key ? `${JOB_PATHS.available}?avviso=${key}` : JOB_PATHS.available);
          return;
        }
        setError(r.error);
        setOpen(false);
        sending.current = false;
      } catch {
        setError(JOB_MSG.generic);
        setOpen(false);
        sending.current = false;
      }
    });
  }

  return (
    <>
      {vehicles.length > 1 ? (
        <fieldset className="rounded-2xl border border-zinc-200 bg-white p-4">
          <legend className="px-1 text-sm font-semibold tracking-wide text-zinc-500 uppercase">Con quale veicolo?</legend>
          <div className="mt-1 space-y-2">
            {vehicles.map((v) => (
              <label
                key={v.id}
                className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 ${
                  v.id === vehicleId ? "border-[#0B3B8C] bg-blue-50" : "border-zinc-200"
                }`}
              >
                <input
                  type="radio"
                  name="vehicleId"
                  value={v.id}
                  checked={v.id === vehicleId}
                  onChange={() => {
                    setVehicleId(v.id);
                    setError(null);
                  }}
                  disabled={pending}
                  className="size-5 accent-[#0B3B8C]"
                />
                <span className="min-w-0 break-words text-zinc-900">{v.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : vehicle ? (
        <p className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm text-zinc-700">
          Veicolo: <span className="font-medium text-zinc-900">{vehicle.label}</span>
        </p>
      ) : null}

      <div className={stickyActionBar}>
        {error ? (
          <p role="alert" className="mb-2 rounded-lg bg-red-50 p-2 text-sm text-red-800">
            {error}
          </p>
        ) : null}
        <button type="button" onClick={openConfirm} disabled={pending} className={bigButton}>
          Accetta la Corsa
        </button>
      </div>

      {open && vehicle ? (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => !sending.current && setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-xl sm:rounded-3xl"
          >
            <h2 id={titleId} className="text-xl font-semibold text-zinc-900">
              Accetti la corsa {summary.orderNumber}?
            </h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-zinc-500">Percorso</dt>
                <dd className="font-medium break-words text-zinc-900">{summary.route}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Ritiro</dt>
                <dd className="font-medium text-zinc-900 first-letter:uppercase">{summary.when}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Veicolo</dt>
                <dd className="font-medium break-words text-zinc-900">{vehicle.label}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Compenso per te</dt>
                <dd className="text-2xl font-bold text-zinc-900">{summary.amount}</dd>
              </div>
            </dl>
            <p className="mt-4 text-sm text-zinc-600">
              Accettando ti impegni a effettuare la corsa. Dopo potrai rinunciare solo entro 15 minuti oppure fino a 48 ore prima del ritiro.
            </p>
            <div className="mt-5 space-y-3">
              <button ref={confirmRef} type="button" onClick={confirm} disabled={pending} aria-busy={pending} className={bigButton}>
                {pending ? "Accettazione in corso…" : "Conferma e accetta"}
              </button>
              <button type="button" onClick={() => setOpen(false)} disabled={pending} className={bigButtonSecondary}>
                Annulla
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
