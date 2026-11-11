import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { MAX_EMAIL_ATTEMPTS, outboxStatusLabel, TEMPLATE_LABEL } from "@/lib/notifications/delivery";
import { ADMIN_EMAIL_PATHS, loadEmailProblems, MISSING_DELIVERED_LIST_DAYS } from "@/lib/notifications/admin-outbox";
import { createServiceClient } from "@/lib/supabase/service";
import { resendDeliveredEmailAction, resendEmailAction } from "./actions";

export const metadata = { title: "E-mail – Transigo" };

// E-mail with problems (D131): "Fallito" after 5 attempts, rows being retried by the cron, delivered orders
// without the delivery e-mail. email_outbox is service-role only: the admin session is checked FIRST.
export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

const rome = (iso: string) => new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" });

async function Content() {
  await requireArea("admin", ADMIN_EMAIL_PATHS.list);
  let data: Awaited<ReturnType<typeof loadEmailProblems>> | null = null;
  try {
    data = await loadEmailProblems(createServiceClient());
  } catch (e) {
    console.error("[admin-email] load:", e instanceof Error ? e.message : e);
  }

  return (
    <AdminShell title="E-mail non inviate">
      <p className="mb-4 text-sm text-zinc-600">
        Gli invii non riusciti vengono ritentati automaticamente ogni 15 minuti, al massimo {MAX_EMAIL_ATTEMPTS} volte; poi
        l&apos;e-mail risulta «Fallito». «Invia di nuovo» avvia una nuova serie di tentativi.
      </p>
      {!data ? <p className="text-sm text-red-700">Errore nel caricamento delle e-mail.</p> : null}

      {data ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="py-2 pr-3 font-medium">Creata</th>
                <th className="py-2 pr-3 font-medium">Ordine</th>
                <th className="py-2 pr-3 font-medium">E-mail</th>
                <th className="py-2 pr-3 font-medium">Stato</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">{rome(r.created_at)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {r.order_id && r.orders ? (
                      <Link href={`/admin/ordini/${r.order_id}`} className="text-blue-700 hover:underline">{r.orders.order_number}</Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {TEMPLATE_LABEL[r.template_code] ?? r.template_code}
                    <div className="text-xs text-zinc-500">{r.to_address}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={r.status === "failed" ? "font-medium text-red-700" : "text-amber-700"}>{outboxStatusLabel(r)}</span>
                    {r.error ? <div className="max-w-xs text-xs break-words text-zinc-500">{r.error}</div> : null}
                  </td>
                  <td className="py-2">
                    <ActionForm action={resendEmailAction} submitLabel="Invia di nuovo" variant="secondary">
                      <input type="hidden" name="id" value={r.id} />
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.rows.length ? <p className="mt-2 text-sm text-zinc-600">Nessuna e-mail in errore.</p> : null}
        </div>
      ) : null}

      {data?.missing.length ? (
        <section className="mt-8">
          <h2 className="mb-2 text-lg font-semibold text-zinc-900">Consegna senza e-mail</h2>
          <p className="mb-2 text-sm text-zinc-600">
            Ordini consegnati negli ultimi {MISSING_DELIVERED_LIST_DAYS} giorni per cui il cliente non ha ricevuto l&apos;e-mail di consegna.
          </p>
          <ul className="divide-y divide-zinc-100 text-sm">
            {data.missing.map((m) => (
              <li key={m.orderId} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span>
                  <Link href={`/admin/ordini/${m.orderId}`} className="text-blue-700 hover:underline">{m.orderNumber}</Link>
                  <span className="ml-2 text-zinc-500">consegnato {rome(m.deliveredAt)}</span>
                </span>
                <ActionForm action={resendDeliveredEmailAction} submitLabel="Invia di nuovo" variant="secondary">
                  <input type="hidden" name="orderId" value={m.orderId} />
                </ActionForm>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AdminShell>
  );
}
