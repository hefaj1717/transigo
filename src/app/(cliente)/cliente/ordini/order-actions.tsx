"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cancelUnpaid, payNow, type OrderActionState } from "./actions";

const initial: OrderActionState = {};

export function PayNowButton({ orderId, compact = false }: { orderId: string; compact?: boolean }) {
  const [state, action, pending] = useActionState(payNow, initial);
  return (
    <form action={action} className={compact ? "inline" : "space-y-2"}>
      <input type="hidden" name="orderId" value={orderId} />
      <button type="submit" disabled={pending} className={`rounded-md bg-blue-600 font-medium text-white hover:bg-blue-700 disabled:opacity-60 ${compact ? "px-3 py-1 text-xs" : "px-4 py-2"}`}>
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
    <div role="status" className="rounded-md bg-blue-50 p-4 text-sm text-blue-900">
      <p className="font-medium">Pagamento in verifica…</p>
      <p className="mt-1">
        {tries < 40
          ? "Stiamo aspettando la conferma da Stripe. La pagina si aggiorna da sola."
          : "La conferma sta richiedendo più tempo del solito. Riceverai un'e-mail appena il pagamento sarà confermato."}
      </p>
    </div>
  );
}
