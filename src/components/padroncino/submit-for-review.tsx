"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitForReviewAction } from "@/app/(padroncino)/padroncino/actions";
import type { MissingItem } from "@/lib/carriers/onboarding";
import { bigButton } from "./carrier-shell";

// "Invia per la verifica" (D100). Disabled until carrier_onboarding_missing() is empty; the database checks again.
export function SubmitForReview({ canSubmit, resubmit, describe }: { canSubmit: boolean; resubmit: boolean; describe: Record<string, MissingItem> }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);

  function submit() {
    setError(null);
    setMissing([]);
    startTransition(async () => {
      const r = await submitForReviewAction();
      if (r.error) {
        setError(r.error);
        setMissing(r.missing ?? []);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          <p>{error}</p>
          {missing.length ? (
            <ul className="mt-2 list-disc pl-5">
              {missing.map((code) => {
                const item = describe[code];
                return <li key={code}>{item ? <Link href={item.href} className="underline">{item.label}</Link> : code}</li>;
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
      <button type="button" onClick={submit} disabled={!canSubmit || pending} className={bigButton}>
        {pending ? "Invio…" : resubmit ? "Invia di nuovo per la verifica" : "Invia per la verifica"}
      </button>
      {!canSubmit ? <p className="text-xs text-zinc-500">Il pulsante si attiva quando hai completato tutti i passaggi.</p> : null}
    </div>
  );
}
