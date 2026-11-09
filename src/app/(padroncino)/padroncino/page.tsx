import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { CarrierShell } from "@/components/padroncino/carrier-shell";
import { requireArea } from "@/lib/auth/session";
import { carrierPanelView } from "@/lib/auth/routing";
import { PendingVerification } from "./pending-verification";

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
        <PendingVerification userId={ctx.userId} />
      </CarrierShell>
    );
  }
  return (
    <CarrierShell title={greeting}>
      <p>Il tuo account è attivo. A breve qui troverai le corse disponibili.</p>
    </CarrierShell>
  );
}
