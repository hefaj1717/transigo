import { createClient } from "@/lib/supabase/server";
import { carrierOnboarding, carrierOnboardingView } from "@/lib/carriers/onboarding";
import type { CarrierStatus } from "@/lib/auth/routing";

// Shown instead of the carrier panel while carriers.status <> 'active'.
// Reads with the user's own session, so RLS limits it to the carrier's own rows; what is missing comes
// from carrier_onboarding_missing() (D99). The onboarding screens replace this in the next commits.
export async function PendingVerification({ userId }: { userId: string }) {
  const supabase = await createClient();
  const [{ data: carrier }, missingResult] = await Promise.all([
    supabase.from("carriers").select("status, status_reason, submitted_at, phone_verified_at, stripe_payouts_enabled").maybeSingle(),
    supabase.rpc("carrier_onboarding_missing", { p_carrier_id: userId }),
  ]);
  if (missingResult.error) console.error("carrier_onboarding_missing failed", { code: missingResult.error.code });

  const view = carrierOnboardingView((carrier?.status as CarrierStatus | undefined) ?? null, carrier?.submitted_at ?? null);
  const { notice, items } = carrierOnboarding({
    view,
    missing: (missingResult.data as string[] | null) ?? [],
    statusReason: carrier?.status_reason ?? null,
    submittedAt: carrier?.submitted_at ?? null,
    phoneVerified: !!carrier?.phone_verified_at,
    stripePayoutsEnabled: !!carrier?.stripe_payouts_enabled,
  });

  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 p-5">
      <h2 className="text-lg font-semibold text-amber-900">Account in attesa di verifica</h2>
      {notice ? <p className="mt-2 text-sm text-amber-900">{notice}</p> : (
        <p className="mt-2 text-sm text-amber-900">
          Per iniziare a ricevere corse completa i passaggi qui sotto. Il team Transigo verificherà i tuoi dati e attiverà l&apos;account.
        </p>
      )}
      <ul className="mt-4 space-y-2">
        {items.map((item) => {
          // If the check failed, show nothing as done (fail closed).
          const done = missingResult.error && item.key !== "approval" ? false : item.done;
          return (
            <li key={item.key} className="flex items-start gap-2 text-sm">
              <span aria-hidden className={done ? "text-green-700" : "text-zinc-400"}>{done ? "✓" : "○"}</span>
              <span className={done ? "text-zinc-700" : "text-zinc-900"}>
                {item.label}
                <span className="sr-only">{done ? " (completato)" : " (da completare)"}</span>
                {!done && item.comingSoon ? <span className="ml-2 text-xs text-zinc-500">disponibile a breve</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
