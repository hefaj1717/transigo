import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { ADMIN_CLAIM_PATHS, CLAIM_NOTE_MAX } from "@/lib/claims/admin";
import { CLAIM_CATEGORY_LABEL, CLAIM_STATUS_LABEL, type ClaimCategory } from "@/lib/claims/claims";
import { ADMIN_ORDER_PATHS } from "@/lib/orders/dispatch";
import { ORDER_STATUS_LABEL } from "@/lib/orders/status";
import { createClient } from "@/lib/supabase/server";
import { closeClaimAction } from "../actions";

export const metadata = { title: "Reclamo – Transigo" };

// One claim (D138): description, photos (signed URLs of 5 min made with the ADMIN's session — bucket policy), the
// order and the customer, and "Chiudi con nota" (the note is shown to the customer and sent by e-mail).
export default function Page({ params }: PageProps<"/admin/reclami/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} />
    </Suspense>
  );
}

type Detail = {
  id: string; order_id: string; category: ClaimCategory; description: string; status: "open" | "closed";
  created_at: string; closed_at: string | null; closed_by: string | null; resolution_note: string | null;
  orders: {
    order_number: string; status: string; delivered_at: string | null; carriers: { company_name: string } | null;
    customers: { profiles: { first_name: string | null; last_name: string | null; email: string; phone: string | null } | null } | null;
  } | null;
  claim_photos: { id: string; storage_path: string; created_at: string }[];
};

const rome = (iso: string | null) => (iso ? new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }) : "—");

async function Content({ params }: Pick<PageProps<"/admin/reclami/[id]">, "params">) {
  const { id } = await params;
  await requireArea("admin", ADMIN_CLAIM_PATHS.detail(id));
  if (!z.uuid().safeParse(id).success) notFound();

  const db = await createClient();
  const { data: c, error } = await db
    .from("claims")
    .select("id, order_id, category, description, status, created_at, closed_at, closed_by, resolution_note, orders(order_number, status, delivered_at, carriers(company_name), customers(profiles(first_name, last_name, email, phone))), claim_photos(id, storage_path, created_at)")
    .eq("id", id)
    .maybeSingle<Detail>();
  if (error) throw new Error(`claim unavailable: ${error.code}`);
  if (!c) notFound();

  const photos = [...c.claim_photos].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const urls = new Map<string, string>();
  if (photos.length) {
    const { data: signed } = await db.storage.from("claim-photos").createSignedUrls(photos.map((p) => p.storage_path), 300);
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }
  const { data: closer } = c.closed_by ? await db.from("profiles").select("email").eq("id", c.closed_by).maybeSingle() : { data: null };
  const o = c.orders;
  const p = o?.customers?.profiles;

  return (
    <AdminShell title={`Reclamo – ${CLAIM_CATEGORY_LABEL[c.category]}`}>
      <p className="mb-4 text-sm"><Link href={ADMIN_CLAIM_PATHS.list} className="text-blue-700 hover:underline">← Reclami</Link></p>
      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <section className="space-y-4">
          <blockquote className="whitespace-pre-line rounded-md border-l-4 border-zinc-300 bg-zinc-50 p-4 text-zinc-800">{c.description}</blockquote>
          {photos.length ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {photos.map((ph) =>
                urls.get(ph.storage_path) ? (
                  <li key={ph.id}>
                    <a href={urls.get(ph.storage_path)} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, 5 min */}
                      <img src={urls.get(ph.storage_path)} alt="Foto del reclamo" className="aspect-square w-full rounded-md border border-zinc-200 object-cover" />
                    </a>
                  </li>
                ) : null,
              )}
            </ul>
          ) : <p className="text-sm text-zinc-500">Nessuna foto.</p>}

          {c.status === "open" ? (
            <ActionForm action={closeClaimAction} submitLabel="Chiudi il reclamo" className="rounded-md border border-zinc-200 p-3">
              <input type="hidden" name="claimId" value={c.id} />
              <label htmlFor="note" className="block text-sm font-medium text-zinc-800">Risposta per il cliente (obbligatoria)</label>
              <textarea id="note" name="note" required maxLength={CLAIM_NOTE_MAX} rows={5} className={`${inputClass} mt-1 w-full`} />
              <p className="mt-1 text-xs text-zinc-500">
                Il cliente la vede in «I miei reclami» e la riceve via e-mail. Note solo per il team: «Note interne» dell&apos;ordine.
                Un eventuale rimborso: «Rimborso manuale» nell&apos;ordine (motivo «Reclamo»).
              </p>
            </ActionForm>
          ) : (
            <div className="rounded-md bg-zinc-50 p-3 text-sm">
              <p className="font-medium text-zinc-900">Risposta al cliente · {rome(c.closed_at)}{closer?.email ? ` · ${closer.email}` : ""}</p>
              <p className="mt-1 whitespace-pre-line text-zinc-700">{c.resolution_note}</p>
            </div>
          )}
        </section>
        <aside className="text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-zinc-500">Stato</dt><dd>{CLAIM_STATUS_LABEL[c.status]}</dd>
            <dt className="text-zinc-500">Aperto</dt><dd>{rome(c.created_at)}</dd>
            <dt className="text-zinc-500">Ordine</dt>
            <dd>
              <Link href={ADMIN_ORDER_PATHS.detail(c.order_id)} className="text-blue-700 hover:underline">{o?.order_number}</Link>
              {o ? <div className="text-xs text-zinc-500">{ORDER_STATUS_LABEL[o.status] ?? o.status} · consegnato {rome(o.delivered_at)}</div> : null}
            </dd>
            <dt className="text-zinc-500">Padroncino</dt><dd>{o?.carriers?.company_name ?? "—"}</dd>
            <dt className="text-zinc-500">Cliente</dt>
            <dd>
              {[p?.first_name, p?.last_name].filter(Boolean).join(" ") || "—"}
              {p?.email ? <div><a href={`mailto:${p.email}`} className="text-blue-700 underline">{p.email}</a></div> : null}
              {p?.phone ? <div><a href={`tel:${p.phone.replace(/\s+/g, "")}`} className="text-blue-700 underline">{p.phone}</a></div> : null}
            </dd>
          </dl>
          <p className="mt-3 text-xs text-zinc-500">Il padroncino non vede i reclami (D138).</p>
        </aside>
      </div>
    </AdminShell>
  );
}
