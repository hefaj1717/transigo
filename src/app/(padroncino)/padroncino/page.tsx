import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { bigButtonSecondary, CarrierShell } from "@/components/padroncino/carrier-shell";
import { requireArea } from "@/lib/auth/session";
import { carrierPanelView } from "@/lib/auth/routing";
import { CARRIER_PATHS } from "@/lib/carriers/onboarding";
import { OnboardingHome } from "./onboarding-home";

export const metadata = { title: "Area padroncino – Transigo" };

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const ctx = await requireArea("padroncino", "/padroncino");
  const greeting = `Ciao${ctx.firstName ? `, ${ctx.firstName}` : ""}!`;

  if (carrierPanelView(ctx) === "pending") {
    return (
      <CarrierShell title={greeting}>
        <OnboardingHome userId={ctx.userId} />
      </CarrierShell>
    );
  }
  return (
    <CarrierShell title={greeting}>
      <p>Il tuo account è attivo. A breve qui troverai le corse disponibili.</p>
      <div className="mt-6 space-y-3">
        <Link href={CARRIER_PATHS.vehicles} className={bigButtonSecondary}>I miei veicoli</Link>
        <Link href={CARRIER_PATHS.documents} className={bigButtonSecondary}>Documenti aziendali</Link>
      </div>
    </CarrierShell>
  );
}
