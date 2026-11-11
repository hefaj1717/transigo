import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { ADMIN_CLAIM_PATHS } from "@/lib/claims/admin";
import { CLAIM_CATEGORY_LABEL, CLAIM_STATUS_LABEL, type ClaimCategory } from "@/lib/claims/claims";
import { ADMIN_CUSTOMER_PATHS, BLOCK_REASON_LABEL, BLOCK_REASONS, CUSTOMER_TYPE_LABEL, customerDisplayName } from "@/lib/customers/admin";
import { ADMIN_ORDER_PATHS } from "@/lib/orders/dispatch";
import { orderStatusLabel } from "@/lib/orders/status";
import { formatCents } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import { setCustomerBlockedAction } from "../actions";

export const metadata = { title: "Cliente – Transigo" };

// One customer (spec 9, D143): personal and billing data, orders, claims, block / unblock with the history from the
// audit log. Read with the admin's session (RLS). Invoices — step 4.
export default function Page({ params }: PageProps<"/admin/clienti/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} />
    </Suspense>
  );
}

type Detail = {
  profile_id: string; customer_type: string; company_name: string | null; vat_number: string | null; fiscal_code: string | null;
  sdi_code: string | null; pec: string | null; billing_street: string | null; billing_city: string | null; billing_postal_code: string | null;
  billing_province: string | null; billing_country: string; created_at: string;
  profiles: { first_name: string | null; last_name: string | null; email: string; phone: string | null; is_blocked: boolean; privacy_accepted_at: string | null } | null;
  orders: { id: string; order_number: string; service_type: string; status: string; created_at: string; pickup_window_start: string; order_charges: { total_cents: number; refunded_cents: number } | null }[];
};
type AuditRow = { id: number; action: string; actor_email: string | null; data: { reason?: string; active_orders?: number }; created_at: string };

const ACTIVE = ["paid", "assigned", "picked_up", "in_transit", "cancellation_review", "payment_review"];
const rome = (iso: string | null) => (iso ? new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }) : "—");

async function Content({ params }: Pick<PageProps<"/admin/clienti/[id]">, "params">) {
  const { id } = await params;
  await requireArea("admin", ADMIN_CUSTOMER_PATHS.detail(id));
  if (!z.uuid().safeParse(id).success) notFound();

  const db = await createClient();
  const { data: c, error } = await db
    .from("customers")
    .select("profile_id, customer_type, company_name, vat_number, fiscal_code, sdi_code, pec, billing_street, billing_city, billing_postal_code, billing_province, billing_country, created_at, profiles(first_name, last_name, email, phone, is_blocked, privacy_accepted_at), orders(id, order_number, service_type, status, created_at, pickup_window_start, order_charges(total_cents, refunded_cents))")
    .eq("profile_id", id)
    .maybeSingle<Detail>();
  if (error) throw new Error(`customer unavailable: ${error.code}`);
  if (!c || !c.profiles) notFound();

  const [{ data: claims }, { data: audit }] = await Promise.all([
    db.from("claims").select("id, order_id, category, status, created_at").eq("customer_id", id).order("created_at", { ascending: false })
      .returns<{ id: string; order_id: string; category: ClaimCategory; status: "open" | "closed"; created_at: string }[]>(),
    db.from("audit_log").select("id, action, actor_email, data, created_at").eq("entity_type", "customer").eq("entity_id", id).order("created_at", { ascending: false }).limit(20)
      .returns<AuditRow[]>(),
  ]);
  const p = c.profiles;
  const orders = [...c.orders].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const active = orders.filter((o) => ACTIVE.includes(o.status));
  const paidTotal = orders.reduce((s, o) => s + (o.order_charges && !["pending_payment", "expired"].includes(o.status) ? o.order_charges.total_cents - o.order_charges.refunded_cents : 0), 0);
  const billing = [c.billing_street, [c.billing_postal_code, c.billing_city, c.billing_province ? `(${c.billing_province})` : null].filter(Boolean).join(" "), c.billing_country !== "IT" ? c.billing_country : null].filter(Boolean).join(", ");

  return (
    <AdminShell title={customerDisplayName({ ...c, first_name: p.first_name, last_name: p.last_name, email: p.email })}>
      <p className="mb-4 text-sm"><Link href={ADMIN_CUSTOMER_PATHS.list} className="text-blue-700 hover:underline">← Clienti</Link></p>
      {p.is_blocked ? <p className="mb-4 rounded-md bg-red-50 p-3 text-sm font-medium text-red-900">Account bloccato: il cliente non può accedere né prenotare.</p> : null}

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h2 className="mb-2 text-lg font-semibold text-zinc-900">Dati</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <Row label="Tipo">{CUSTOMER_TYPE_LABEL[c.customer_type] ?? c.customer_type}</Row>
            <Row label="Nome">{[p.first_name, p.last_name].filter(Boolean).join(" ") || "—"}</Row>
            <Row label="E-mail"><a href={`mailto:${p.email}`} className="text-blue-700 underline">{p.email}</a></Row>
            <Row label="Telefono">{p.phone ? <a href={`tel:${p.phone.replace(/\s+/g, "")}`} className="text-blue-700 underline">{p.phone}</a> : "—"}</Row>
            <Row label="Registrato">{rome(c.created_at)}</Row>
            <Row label="Privacy">{p.privacy_accepted_at ? `accettata ${rome(p.privacy_accepted_at)}` : "—"}</Row>
          </dl>
        </section>
        <section>
          <h2 className="mb-2 text-lg font-semibold text-zinc-900">Dati di fatturazione</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {c.customer_type === "business" ? <Row label="Ragione sociale">{c.company_name ?? "—"}</Row> : null}
            {c.vat_number ? <Row label="P.IVA">{c.vat_number}</Row> : null}
            <Row label="Codice fiscale">{c.fiscal_code ?? "—"}</Row>
            {c.customer_type === "business" ? <Row label="SDI / PEC">{[c.sdi_code, c.pec].filter(Boolean).join(" · ") || "—"}</Row> : null}
            <Row label="Indirizzo">{billing || "—"}</Row>
          </dl>
          <p className="mt-2 text-xs text-zinc-500">Le fatture arriveranno con la fatturazione elettronica.</p>
        </section>
      </div>

      <section className="mt-8">
        <h2 className="mb-2 text-lg font-semibold text-zinc-900">Ordini ({orders.length}) · pagato netto rimborsi {formatCents(paidTotal)}</h2>
        {orders.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-zinc-500">
                <tr><th className="py-1 pr-3 font-medium">Ordine</th><th className="py-1 pr-3 font-medium">Creato</th><th className="py-1 pr-3 font-medium">Ritiro</th><th className="py-1 pr-3 font-medium">Stato</th><th className="py-1 text-right font-medium">Totale</th></tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-t border-zinc-100">
                    <td className="py-1 pr-3"><Link href={ADMIN_ORDER_PATHS.detail(o.id)} className="text-blue-700 hover:underline">{o.order_number}</Link></td>
                    <td className="py-1 pr-3 whitespace-nowrap">{rome(o.created_at)}</td>
                    <td className="py-1 pr-3 whitespace-nowrap">{rome(o.pickup_window_start)}</td>
                    <td className="py-1 pr-3">{orderStatusLabel(o.status, o.service_type)}</td>
                    <td className="py-1 text-right">{o.order_charges ? formatCents(o.order_charges.total_cents) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-zinc-600">Nessun ordine.</p>}
      </section>

      {claims?.length ? (
        <section className="mt-8">
          <h2 className="mb-2 text-lg font-semibold text-zinc-900">Reclami</h2>
          <ul className="space-y-1 text-sm">
            {claims.map((cl) => (
              <li key={cl.id}>
                <Link href={ADMIN_CLAIM_PATHS.detail(cl.id)} className="text-blue-700 hover:underline">{CLAIM_CATEGORY_LABEL[cl.category]}</Link>
                {" "}· {CLAIM_STATUS_LABEL[cl.status]} · {rome(cl.created_at)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="mb-2 text-lg font-semibold text-zinc-900">Accesso</h2>
        {p.is_blocked ? (
          <ActionForm action={setCustomerBlockedAction} submitLabel="Sblocca cliente" className="max-w-md rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="customerId" value={c.profile_id} />
            <input type="hidden" name="block" value="0" />
            <p className="text-sm text-zinc-700">Il cliente potrà di nuovo accedere e prenotare.</p>
          </ActionForm>
        ) : (
          <ActionForm action={setCustomerBlockedAction} submitLabel="Blocca cliente" variant="danger" className="max-w-md rounded-md border border-zinc-200 p-3">
            <input type="hidden" name="customerId" value={c.profile_id} />
            <input type="hidden" name="block" value="1" />
            <label htmlFor="reason" className="block text-sm font-medium text-zinc-800">Motivo</label>
            <select id="reason" name="reason" required defaultValue="" className={`${inputClass} mt-1 w-full`}>
              <option value="" disabled>Scegli…</option>
              {BLOCK_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
            <p className="mt-1 text-xs text-zinc-500">Il cliente non potrà più accedere. I dettagli vanno nelle «Note interne» di un ordine o in un documento del team.</p>
            {active.length ? (
              <p className="mt-2 text-sm font-medium text-amber-900">
                {active.length === 1 ? "1 ordine in corso continuerà" : `${active.length} ordini in corso continueranno`} normalmente (ritiro, consegna, rimborsi).
                Il cliente non potrà vederli finché è bloccato.
              </p>
            ) : null}
          </ActionForm>
        )}
        {audit?.length ? (
          <ul className="mt-3 space-y-0.5 text-xs text-zinc-600">
            {audit.map((a) => (
              <li key={a.id}>
                {rome(a.created_at)} · {a.action === "customer.blocked" ? `bloccato (${BLOCK_REASON_LABEL[a.data.reason ?? ""] ?? a.data.reason})` : "sbloccato"} · {a.actor_email ?? "—"}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </AdminShell>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-zinc-900">{children}</dd>
    </>
  );
}
