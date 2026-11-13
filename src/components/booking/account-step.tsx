"use client";

import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import type { WizardSession } from "@/lib/booking/session";

// "Account" step of the booking wizards (D8, D70, D80). `returnTo` = the wizard URL with ?passo=account, so the
// customer comes back to the same step after signing in; the wizard state stays in localStorage (D78).
export function AccountStep({ session, returnTo }: { session: WizardSession; returnTo: string }) {
  const next = encodeURIComponent(returnTo);
  return (
    <div className="space-y-3 text-sm">
      {session.kind === "customer" ? (
        <p className="rounded-md bg-green-50 p-3 text-green-900">Hai effettuato l&apos;accesso{session.firstName ? ` come ${session.firstName}` : ""}. Prosegui con i contatti.</p>
      ) : session.kind === "incomplete" ? (
        <p>
          Completa il tuo profilo per continuare:{" "}
          <Link className="text-blue-700 underline" href={`/completa-profilo?next=${next}`}>completa il profilo</Link>.
        </p>
      ) : session.kind === "other_role" ? (
        <>
          <p className="rounded-md bg-amber-50 p-3 text-amber-900">
            Hai effettuato l&apos;accesso{session.role === "admin" ? " come amministratore" : session.role === "padroncino" ? " come trasportatore" : ""}. Solo i clienti possono prenotare: esci e accedi con un account cliente. Il preventivo resta salvato su questo dispositivo.
          </p>
          <SignOutButton next={returnTo} label="Esci e accedi come cliente" className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700" />
        </>
      ) : session.kind === "blocked" ? (
        // Plain text, not a red box: "Avanti" shows the red step error (accountStepError) — one alert, not two.
        // The header shows "Accedi" to a blocked session, so the way out is here.
        <>
          <p>
            Non è possibile prenotare con un account sospeso. Per assistenza{" "}
            <Link className="text-blue-700 underline" href="/contatti">contattaci</Link>.
          </p>
          <SignOutButton next={returnTo} label="Esci" className="rounded-md border border-zinc-300 px-4 py-2 font-medium text-zinc-800 hover:bg-zinc-50" />
        </>
      ) : (
        <>
          <p>Per confermare la prenotazione serve un account cliente. Il preventivo resta salvato su questo dispositivo.</p>
          <div className="flex flex-wrap gap-3">
            <Link href={`/accedi?next=${next}`} className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700">Accedi</Link>
            <Link href="/registrati?tipo=cliente" className="rounded-md border border-blue-600 px-4 py-2 font-medium text-blue-700 hover:bg-blue-50">Registrati</Link>
          </div>
          <p className="text-xs text-zinc-500">Dopo la registrazione conferma l&apos;indirizzo e-mail: dall&apos;area cliente potrai riprendere la prenotazione.</p>
        </>
      )}
    </div>
  );
}
