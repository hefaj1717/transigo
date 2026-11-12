import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { getAccountContext } from "@/lib/auth/session";
import { loadStorageOptions } from "@/lib/booking/storage/server";
import { parseStoragePrefill } from "@/lib/booking/storage/state";
import { toWizardSession } from "@/lib/booking/session";
import { createServiceClient } from "@/lib/supabase/service";
import { StorageWizard } from "./wizard";

export const metadata = { title: "Prenota il deposito – Transigo" };

// Deposito wizard (D151, D153–D158): box o pallet → periodo (disponibilità) → arrivo della merce → uscita →
// merce → facchini (solo con trasporto) → preventivo → account → contatti → riepilogo → pagamento (tutto subito,
// D172). Prices only on the server (/api/booking/storage-quote).
export default function Page({ searchParams }: PageProps<"/prenota/deposito">) {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
      <h1 className="text-2xl font-semibold text-zinc-900">Prenota il deposito</h1>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Content({ searchParams }: Pick<PageProps<"/prenota/deposito">, "searchParams">) {
  const sp = await searchParams;
  const [ctx, options] = await Promise.all([getAccountContext(), loadStorageOptions(createServiceClient())]);
  if (!options.available) {
    return <p className="mt-6 rounded-md bg-amber-50 p-4 text-sm text-amber-900">Il deposito non è prenotabile online in questo momento. <a href="/contatti" className="underline">Contattaci</a>: ti aiutiamo noi.</p>;
  }
  return (
    <StorageWizard
      options={options}
      session={toWizardSession(ctx)}
      initialStep={typeof sp.passo === "string" ? sp.passo : null}
      prefill={parseStoragePrefill(sp, options.boxes.map((b) => b.code))}
    />
  );
}
