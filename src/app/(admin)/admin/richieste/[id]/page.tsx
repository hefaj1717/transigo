import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { ADMIN_CONTACT_PATHS } from "@/lib/contact/server";
import { createClient } from "@/lib/supabase/server";
import { setContactStatusAction } from "../actions";

export const metadata = { title: "Richiesta – Transigo" };

// One contact request (D125): sender, message, route (out_of_area), consent, status with
// "Segna come gestita" / "Riapri". Reply by e-mail from the admin's own mailbox (mailto).
export default function Page({ params }: PageProps<"/admin/richieste/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} />
    </Suspense>
  );
}

type Detail = {
  id: string; kind: string; status: "new" | "handled"; name: string; email: string; phone: string | null; message: string;
  pickup_city: string | null; pickup_province: string | null; delivery_city: string | null; delivery_province: string | null;
  route_distance_km: number | null; privacy_accepted_at: string; privacy_version: string; created_at: string; handled_at: string | null;
  handler: { email: string } | null;
};

const KIND_LABEL: Record<string, string> = { general: "Modulo contatti", out_of_area: "Zona non servita (prenotazione)" };
const rome = (iso: string) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" });
const place = (city: string | null, province: string | null) => [city, province ? `(${province})` : null].filter(Boolean).join(" ") || "—";

async function Content({ params }: Pick<PageProps<"/admin/richieste/[id]">, "params">) {
  const { id } = await params;
  await requireArea("admin", ADMIN_CONTACT_PATHS.detail(id));
  if (!z.uuid().safeParse(id).success) notFound();

  const db = await createClient();
  const { data: r } = await db
    .from("contact_requests")
    .select("id, kind, status, name, email, phone, message, pickup_city, pickup_province, delivery_city, delivery_province, route_distance_km, privacy_accepted_at, privacy_version, created_at, handled_at, handler:profiles!contact_requests_handled_by_fkey(email)")
    .eq("id", id)
    .maybeSingle<Detail>();
  if (!r) notFound();

  const subject = encodeURIComponent("Risposta alla tua richiesta – Transigo");
  return (
    <AdminShell title="Richiesta">
      <p className="mb-4 text-sm">
        <Link href={ADMIN_CONTACT_PATHS.list} className="text-blue-700 hover:underline">← Tutte le richieste</Link>
      </p>
      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">{r.name}</h2>
            <p className="text-sm">
              <a href={`mailto:${r.email}?subject=${subject}`} className="text-blue-700 underline">{r.email}</a>
              {r.phone ? <> · <a href={`tel:${r.phone.replace(/\s+/g, "")}`} className="text-blue-700 underline">{r.phone}</a></> : null}
            </p>
          </div>
          <blockquote className="whitespace-pre-line rounded-md border-l-4 border-zinc-300 bg-zinc-50 p-4 text-zinc-800">{r.message}</blockquote>
          {r.kind === "out_of_area" ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-zinc-500">Ritiro</dt><dd>{place(r.pickup_city, r.pickup_province)}</dd>
              <dt className="text-zinc-500">Consegna</dt><dd>{place(r.delivery_city, r.delivery_province)}</dd>
              <dt className="text-zinc-500">Distanza</dt><dd>{r.route_distance_km != null ? `${r.route_distance_km} km` : "—"}</dd>
            </dl>
          ) : null}
        </section>
        <aside className="space-y-3 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-zinc-500">Tipo</dt><dd>{KIND_LABEL[r.kind] ?? r.kind}</dd>
            <dt className="text-zinc-500">Ricevuta</dt><dd>{rome(r.created_at)}</dd>
            <dt className="text-zinc-500">Stato</dt><dd>{r.status === "handled" ? "Gestita" : "Nuova"}</dd>
            {r.handled_at ? <><dt className="text-zinc-500">Gestita</dt><dd>{rome(r.handled_at)}{r.handler ? <div className="text-xs text-zinc-500">{r.handler.email}</div> : null}</dd></> : null}
            <dt className="text-zinc-500">Privacy</dt><dd>accettata {rome(r.privacy_accepted_at)} (v. {r.privacy_version})</dd>
          </dl>
          <ActionForm action={setContactStatusAction} submitLabel={r.status === "new" ? "Segna come gestita" : "Riapri"} variant={r.status === "new" ? "primary" : "secondary"}>
            <input type="hidden" name="id" value={r.id} />
            <input type="hidden" name="status" value={r.status === "new" ? "handled" : "new"} />
          </ActionForm>
        </aside>
      </div>
    </AdminShell>
  );
}
