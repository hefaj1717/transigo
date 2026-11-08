import { createClient } from "@/lib/supabase/server";
import { carrierOnboarding } from "@/lib/auth/carrier-onboarding";
import type { CarrierStatus } from "@/lib/auth/routing";

// Shown instead of the carrier panel while carriers.status <> 'active'.
// Reads with the user's own session, so RLS limits it to the carrier's own rows.
export async function PendingVerification() {
  const supabase = await createClient();
  const [{ data: carrier }, documents, vehicles] = await Promise.all([
    supabase
      .from("carriers")
      .select("status, status_reason, phone_verified_at, stripe_payouts_enabled, company_name, vat_number, fiscal_code, hq_street, hq_city, hq_postal_code, hq_province, pec, sdi_code")
      .maybeSingle(),
    supabase.from("carrier_documents").select("id", { count: "exact", head: true }),
    supabase.from("carrier_vehicles").select("id", { count: "exact", head: true }).eq("is_active", true),
  ]);

  const { notice, items } = carrierOnboarding({
    status: (carrier?.status as CarrierStatus | undefined) ?? null,
    statusReason: carrier?.status_reason ?? null,
    company: carrier ?? null,
    phoneVerified: !!carrier?.phone_verified_at,
    documentsCount: documents.count ?? 0,
    activeVehiclesCount: vehicles.count ?? 0,
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
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-2 text-sm">
            <span aria-hidden className={item.done ? "text-green-700" : "text-zinc-400"}>{item.done ? "✓" : "○"}</span>
            <span className={item.done ? "text-zinc-700" : "text-zinc-900"}>
              {item.label}
              <span className="sr-only">{item.done ? " (completato)" : " (da completare)"}</span>
              {!item.done && item.comingSoon ? <span className="ml-2 text-xs text-zinc-500">disponibile a breve</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
