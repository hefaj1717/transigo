import { Suspense } from "react";
import { Loading } from "@/components/panel-shell";
import { CarrierShell } from "@/components/padroncino/carrier-shell";
import { DocumentList } from "@/components/padroncino/document-list";
import { requireArea } from "@/lib/auth/session";
import { latestDocuments } from "@/lib/carriers/documents";
import { CARRIER_PATHS, documentEditBlock } from "@/lib/carriers/onboarding";
import { loadCarrier, loadDocuments, signedDocumentUrls } from "@/lib/carriers/pages";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Documenti – Transigo" };

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const ctx = await requireArea("padroncino", CARRIER_PATHS.documents);
  const db = await createClient();
  const [{ view }, rows] = await Promise.all([loadCarrier(db, ctx.userId), loadDocuments(db, ctx.userId)]);
  const latest = latestDocuments(rows);
  const urls = await signedDocumentUrls(db, [...latest.values()]);
  const block = documentEditBlock(view); // D112 (also allowed when suspended)

  return (
    <CarrierShell title="Documenti aziendali" back={{ href: CARRIER_PATHS.home, label: "Indietro" }}>
      <p className="mb-4 text-sm text-zinc-600">
        I documenti del veicolo (libretto e assicurazione RCA) si caricano nella pagina di ciascun{" "}
        <a href={CARRIER_PATHS.vehicles} className="font-medium text-[#0B3B8C] underline">veicolo</a>.
      </p>
      {block ? <p className="mb-4 rounded-lg bg-zinc-100 p-3 text-sm text-zinc-700">{block}</p> : null}
      {view === "suspended" ? (
        <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Carica i documenti aggiornati: il team Transigo li verificherà e deciderà sulla riattivazione dell&apos;account.
        </p>
      ) : null}
      <DocumentList scope="carrier" carrierId={ctx.userId} vehicleId={null} latest={latest} urls={urls} editable={!block} />
    </CarrierShell>
  );
}
