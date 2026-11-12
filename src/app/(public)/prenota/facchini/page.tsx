import { Suspense } from "react";
import { BookingServiceTabs } from "@/components/site/booking-service-tabs";
import { Loading } from "@/components/panel-shell";
import { getAccountContext } from "@/lib/auth/session";
import { loadPortersOptions } from "@/lib/booking/porters/server";
import { parsePortersPrefill } from "@/lib/booking/porters/state";
import { toWizardSession } from "@/lib/booking/session";
import { createServiceClient } from "@/lib/supabase/service";
import { PortersWizard } from "./wizard";

export const metadata = { title: "Prenota il facchinaggio – Transigo" };

// Facchinaggio wizard (D151, D158): indirizzo → data e fascia → facchini → ore → piano → cosa spostare →
// preventivo → account → contatti → riepilogo → pagamento. Prices only on the server (/api/booking/porters-quote).
export default function Page({ searchParams }: PageProps<"/prenota/facchini">) {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
      <BookingServiceTabs active="facchinaggio" />
      <h1 className="text-2xl font-semibold text-zinc-900">Prenota il facchinaggio</h1>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Content({ searchParams }: Pick<PageProps<"/prenota/facchini">, "searchParams">) {
  const sp = await searchParams;
  const [ctx, options] = await Promise.all([getAccountContext(), loadPortersOptions(createServiceClient())]);
  if (!options) {
    return <p className="mt-6 rounded-md bg-amber-50 p-4 text-sm text-amber-900">Il facchinaggio non è prenotabile online in questo momento. <a href="/contatti" className="underline">Contattaci</a>: ti aiutiamo noi.</p>;
  }
  return (
    <PortersWizard
      options={options}
      session={toWizardSession(ctx)}
      initialStep={typeof sp.passo === "string" ? sp.passo : null}
      prefill={parsePortersPrefill(sp, options.minPersons)}
    />
  );
}
