"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/pricing/money";
import { cancelPaid, cancelUnpaid, payNow, type OrderActionState } from "./actions";

const initial: OrderActionState = {};

export function PayNowButton({ orderId, compact = false }: { orderId: string; compact?: boolean }) {
  const [state, action, pending] = useActionState(payNow, initial);
  return (
    <form action={action} className={compact ? "inline" : "space-y-2"}>
      <input type="hidden" name="orderId" value={orderId} />
      <button type="submit" disabled={pending} className={`rounded-md bg-accent-600 font-semibold text-white hover:bg-accent-700 disabled:opacity-60 ${compact ? "px-3 py-1 text-xs" : "px-4 py-2"}`}>
        {pending ? "Attendere…" : "Paga ora"}
      </button>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      {state.message ? <p role="status" className="text-sm text-zinc-700">{state.message}</p> : null}
    </form>
  );
}

export function CancelUnpaidButton({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState(cancelUnpaid, initial);
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-800 hover:bg-zinc-50">
        Annulla ordine
      </button>
    );
  }
  return (
    <form action={action} className="space-y-2 rounded-md border border-zinc-200 p-3 text-sm">
      <input type="hidden" name="orderId" value={orderId} />
      <p>Vuoi annullare questo ordine? Non è stato ancora pagato, quindi non ti verrà addebitato nulla.</p>
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="rounded-md bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-60">
          {pending ? "Attendere…" : "Sì, annulla"}
        </button>
        <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50">
          No
        </button>
      </div>
      {state.error ? <p role="alert" className="text-red-700">{state.error}</p> : null}
    </form>
  );
}

/** After the return from Checkout: refreshes the page every 3 s (up to 2 min) until the webhook sets the status. */
export function PaymentPending() {
  const router = useRouter();
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (tries >= 40) return;
    const t = setTimeout(() => {
      router.refresh();
      setTries((n) => n + 1);
    }, 3000);
    return () => clearTimeout(t);
  }, [tries, router]);
  return (
    <div role="status" className="rounded-md bg-brand-50 p-4 text-sm text-brand-900">
      <p className="font-medium">Pagamento in verifica…</p>
      <p className="mt-1">
        {tries < 40
          ? "Stiamo aspettando la conferma da Stripe. La pagina si aggiorna da sola."
          : "La conferma sta richiedendo più tempo del solito. Riceverai un'e-mail appena il pagamento sarà confermato."}
      </p>
    </div>
  );
}

type PaidPreview =
  | { kind: "free" | "late"; feeCents: number; refundCents: number; freeUntil: string; basis: "pickup" | "storage" }
  | { kind: "review" }
  | { kind: "not_allowed" };

const romeDateTime = (iso: string) =>
  new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

/**
 * D33, D137: "Annulla ordine" for a paid order (free / late with the fee) or "Richiedi l'annullamento" when a
 * carrier has the job. The numbers are the preview; the database computes them again on confirmation.
 */
export function CancelPaidOrder({ orderId, preview, freeHours, feeBp, group = false }: { orderId: string; preview: PaidPreview; freeHours: number; feeBp: number; group?: boolean }) {
  const [state, action, pending] = useActionState(cancelPaid, initial);
  const [confirming, setConfirming] = useState(false);
  if (preview.kind === "not_allowed") return null;
  const review = preview.kind === "review";
  const percent = `${(feeBp / 100).toLocaleString("it-IT")} %`;

  const summary =
    preview.kind === "free" ? (
      <p>
        Puoi annullare gratuitamente fino a <strong>{romeDateTime(preview.freeUntil)}</strong>{" "}
        {preview.basis === "storage" ? "(inizio del deposito; poi contattaci)" : `(${freeHours} ore prima del ritiro)`}.
        {group ? " L'annullamento riguarda tutta la prenotazione: deposito e trasporti collegati." : ""}
      </p>
    ) : preview.kind === "late" ? (
      <p>
        Mancano meno di {freeHours} ore al ritiro: l&apos;annullamento costa il {percent} di trasporto, facchinaggio e imballaggio. Il deposito viene rimborsato per intero.
        {group ? " L'annullamento riguarda tutta la prenotazione: deposito e trasporti collegati." : ""}
      </p>
    ) : (
      <p>Il trasporto è già stato assegnato a un trasportatore: puoi chiedere l&apos;annullamento e il nostro team ti contatterà per il rimborso.</p>
    );

  if (!confirming) {
    return (
      <div className="space-y-3 text-sm text-zinc-700">
        {summary}
        <button type="button" onClick={() => setConfirming(true)} className="rounded-md border border-red-300 px-4 py-2 font-medium text-red-700 hover:bg-red-50">
          {review ? "Richiedi l'annullamento" : "Annulla ordine"}
        </button>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-800">
      <input type="hidden" name="orderId" value={orderId} />
      {preview.kind === "free" || preview.kind === "late" ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {preview.feeCents > 0 ? (<><dt className="text-zinc-500">Costo di annullamento</dt><dd className="font-medium">{formatCents(preview.feeCents)}</dd></>) : null}
          <dt className="text-zinc-500">Rimborso</dt>
          <dd className="font-semibold text-brand-900">{formatCents(preview.refundCents)}</dd>
        </dl>
      ) : (
        <p>La richiesta arriva al nostro team, che decide il rimborso in base al lavoro già organizzato.</p>
      )}
      {preview.kind !== "review" ? <p className="text-xs text-zinc-500">Il rimborso arriva sulla carta usata per il pagamento, di solito in 5–10 giorni lavorativi.</p> : null}
      <div>
        <label htmlFor="cancel-reason" className="block text-sm font-medium text-zinc-800">Motivo (facoltativo)</label>
        <textarea id="cancel-reason" name="reason" maxLength={2000} rows={2} className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-blue-500" />
      </div>
      <p className="font-medium">{review ? "Vuoi inviare la richiesta di annullamento?" : "Vuoi annullare l'ordine? L'operazione non si può annullare."}</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="rounded-md bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-60">
          {pending ? "Attendere…" : review ? "Sì, invia la richiesta" : "Sì, annulla l'ordine"}
        </button>
        <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 hover:bg-zinc-50">
          No
        </button>
      </div>
      {state.error ? <p role="alert" className="text-red-700">{state.error}</p> : null}
    </form>
  );
}
