import { connection } from "next/server";
import { Suspense } from "react";
import { BookingServiceTabs } from "@/components/site/booking-service-tabs";
import { bookingTab, type BookingService } from "@/lib/public/booking-tabs";
import { Loading } from "@/components/panel-shell";
import { getAccountContext } from "@/lib/auth/session";
import { loadPortersOptions } from "@/lib/booking/porters/server";
import { parsePortersPrefill } from "@/lib/booking/porters/state";
import { loadBookingOptions } from "@/lib/booking/server";
import { toWizardSession } from "@/lib/booking/session";
import { loadStorageOptions } from "@/lib/booking/storage/server";
import { parseStoragePrefill } from "@/lib/booking/storage/state";
import { createServiceClient } from "@/lib/supabase/service";
import { BookingHub } from "./booking-hub";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Shared body of /prenota, /prenota/facchini and /prenota/deposito (D151). The options of all three wizards are
// loaded together, so the tabs switch between the wizards in the browser without a new page load (BookingHub).
// Prices are computed only on the server (/api/booking/*-quote, D76).
export function BookingPage({ service, searchParams }: { service: BookingService; searchParams: SearchParams }) {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
      <Suspense
        fallback={
          <>
            <BookingServiceTabs active={service} />
            <h1 className="text-2xl font-semibold text-zinc-900">{bookingTab(service).heading}</h1>
            <Loading />
          </>
        }
      >
        <Content service={service} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Content({ service, searchParams }: { service: BookingService; searchParams: SearchParams }) {
  // Request-time render before loading the price list: it reads the clock (today's holidays, caches) and
  // Next refuses `new Date()` while prerendering ("blocking-prerender-current-time").
  await connection();
  const sp = await searchParams;
  const db = createServiceClient();
  const [ctx, transport, porters, storage] = await Promise.all([
    getAccountContext(),
    loadBookingOptions(db),
    loadPortersOptions(db),
    loadStorageOptions(db),
  ]);
  return (
    <BookingHub
      initial={service}
      initialStep={typeof sp.passo === "string" ? sp.passo : null}
      session={toWizardSession(ctx)}
      transport={transport}
      porters={porters}
      portersPrefill={service === "facchinaggio" && porters ? parsePortersPrefill(sp, porters.minPersons) : {}}
      storage={storage}
      storagePrefill={service === "deposito" && storage.available ? parseStoragePrefill(sp, storage.boxes.map((b) => b.code)) : {}}
    />
  );
}
