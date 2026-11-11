import { Suspense } from "react";
import Link from "next/link";
import { Card, CustomerShell } from "@/components/cliente/customer-shell";
import { Loading } from "@/components/panel-shell";
import { requireArea } from "@/lib/auth/session";
import { CLAIM_CATEGORY_LABEL, CLAIM_MAX_PHOTOS, CLAIM_MSG, CLAIM_STATUS_LABEL, type ClaimCategory } from "@/lib/claims/claims";
import { createClient } from "@/lib/supabase/server";
import { AddClaimPhotos } from "./add-photos";

export const metadata = { title: "I miei reclami – Transigo" };

// "Reclami" (spec 7, D138): the customer's claims with their photos and the team's answer. Read with the customer's
// session (RLS: own claims; photo previews = signed URLs of 5 min made with the same session).
export default function Page({ searchParams }: PageProps<"/cliente/reclami">) {
  return (
    <CustomerShell title="I miei reclami" subtitle="Per aprire un reclamo vai all'ordine consegnato e scegli «Apri un reclamo».">
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </CustomerShell>
  );
}

type ClaimRow = {
  id: string; category: ClaimCategory; description: string; status: "open" | "closed"; created_at: string; closed_at: string | null;
  resolution_note: string | null; order_id: string;
  orders: { order_number: string } | null;
  claim_photos: { id: string; storage_path: string; created_at: string }[];
};

const rome = (iso: string) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "medium", timeStyle: "short" });

async function Content({ searchParams }: Pick<PageProps<"/cliente/reclami">, "searchParams">) {
  await requireArea("cliente", "/cliente/reclami");
  const sp = await searchParams;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("claims")
    .select("id, category, description, status, created_at, closed_at, resolution_note, order_id, orders(order_number), claim_photos(id, storage_path, created_at)")
    .order("created_at", { ascending: false })
    .returns<ClaimRow[]>();
  if (error) return <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{CLAIM_MSG.generic}</p>;
  const claims = data ?? [];

  const paths = claims.flatMap((c) => c.claim_photos.map((p) => p.storage_path));
  const urls = new Map<string, string>();
  if (paths.length) {
    const { data: signed } = await supabase.storage.from("claim-photos").createSignedUrls(paths, 300);
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }

  return (
    <div className="space-y-4">
      {sp.inviato ? <p role="status" className="rounded-md bg-accent-50 p-3 text-sm text-accent-800">{CLAIM_MSG.opened}</p> : null}
      {claims.length === 0 ? (
        <Card><p className="text-sm text-zinc-600">Non hai reclami. <Link href="/cliente?stato=conclusi" className="font-medium underline">Vai agli ordini conclusi</Link></p></Card>
      ) : null}
      {claims.map((c) => {
        const photos = [...c.claim_photos].sort((a, b) => a.created_at.localeCompare(b.created_at));
        return (
          <Card key={c.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-zinc-900">{CLAIM_CATEGORY_LABEL[c.category]}</p>
                <p className="text-sm text-zinc-500">
                  Ordine <Link href={`/cliente/ordini/${c.order_id}`} className="underline">{c.orders?.order_number}</Link> · aperto il {rome(c.created_at)}
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${c.status === "open" ? "bg-amber-100 text-amber-900" : "bg-zinc-100 text-zinc-700"}`}>
                {CLAIM_STATUS_LABEL[c.status]}
              </span>
            </div>
            <p className="mt-3 whitespace-pre-line text-sm text-zinc-800">{c.description}</p>
            {photos.length ? (
              <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
                {photos.map((p) =>
                  urls.get(p.storage_path) ? (
                    <li key={p.id}>
                      <a href={urls.get(p.storage_path)} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, 5 min */}
                        <img src={urls.get(p.storage_path)} alt="Foto del reclamo" className="aspect-square w-full rounded-md border border-zinc-200 object-cover" />
                      </a>
                    </li>
                  ) : null,
                )}
              </ul>
            ) : null}
            {c.status === "open" && photos.length < CLAIM_MAX_PHOTOS ? (
              <div className="mt-3"><AddClaimPhotos claimId={c.id} slots={CLAIM_MAX_PHOTOS - photos.length} /></div>
            ) : null}
            {c.status === "closed" && c.resolution_note ? (
              <div className="mt-4 rounded-md bg-zinc-50 p-3 text-sm">
                <p className="font-medium text-zinc-900">Risposta di Transigo{c.closed_at ? ` · ${rome(c.closed_at)}` : ""}</p>
                <p className="mt-1 whitespace-pre-line text-zinc-700">{c.resolution_note}</p>
              </div>
            ) : c.status === "open" ? (
              <p className="mt-3 text-xs text-zinc-500">Il nostro team sta verificando. Ti risponderemo via e-mail.</p>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
