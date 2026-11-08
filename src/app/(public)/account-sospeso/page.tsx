import { Suspense } from "react";
import { AuthCard } from "@/components/auth-card";
import { Loading } from "@/components/panel-shell";
import { SignOutButton } from "@/components/sign-out-button";
import { getAccountContext, enforce } from "@/lib/auth/session";
import { resolveSuspendedPage } from "@/lib/auth/routing";

export const metadata = { title: "Account sospeso – Transigo" };

export default function Page() {
  return (
    <AuthCard title="Account sospeso">
      <Suspense fallback={<Loading />}>
        <Gate />
      </Suspense>
    </AuthCard>
  );
}

async function Gate() {
  enforce(resolveSuspendedPage(await getAccountContext()));
  return (
    <div className="space-y-4 text-sm text-zinc-700">
      <p>Il tuo account è stato sospeso e al momento non puoi utilizzare i servizi di Transigo.</p>
      <p>Per informazioni contatta il nostro servizio clienti.</p>
      <SignOutButton />
    </div>
  );
}
