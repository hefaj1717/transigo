import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { getAccountContext } from "@/lib/auth/session";
import { loadBookingOptions } from "@/lib/booking/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { WizardSession } from "./types";
import { Wizard } from "./wizard";

export const metadata = { title: "Prenota un trasporto – Transigo" };

// Booking wizard (spec section 6, D70). Steps 1–6 work without an account; the account is required before
// "Contatti" and "Riepilogo". Prices are computed only on the server (/api/booking/quote, D76).
export default function Page({ searchParams }: PageProps<"/prenota">) {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
      <h1 className="text-2xl font-semibold text-zinc-900">Prenota un trasporto</h1>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Content({ searchParams }: Pick<PageProps<"/prenota">, "searchParams">) {
  const sp = await searchParams;
  const [ctx, options] = await Promise.all([getAccountContext(), loadBookingOptions(createServiceClient())]);

  let session: WizardSession = { kind: "anonymous" };
  if (ctx.state === "signed_in") {
    if (ctx.isBlocked) session = { kind: "blocked" };
    else if (ctx.role !== "cliente") session = { kind: "other_role" };
    else if (ctx.customerProfile !== "complete" || !ctx.customerType) session = { kind: "incomplete" };
    else session = { kind: "customer", customerType: ctx.customerType, firstName: ctx.firstName };
  }

  if (!options.available) {
    return <p className="mt-6 rounded-md bg-amber-50 p-4 text-sm text-amber-900">Le prenotazioni online non sono disponibili in questo momento. Riprova più tardi.</p>;
  }
  return <Wizard options={options} session={session} initialStep={typeof sp.passo === "string" ? sp.passo : null} />;
}
