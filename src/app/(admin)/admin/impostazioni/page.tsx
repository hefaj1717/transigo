import { Suspense } from "react";
import Link from "next/link";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { bpToPercentInput, COMPANY_FIELDS } from "@/lib/admin/settings";
import { createClient } from "@/lib/supabase/server";
import { updateCompanyAction, updateRulesAction } from "./actions";

export const metadata = { title: "Impostazioni – Transigo" };

// "Impostazioni" (spec 9): Transigo's company data (footer of the website, "Contatta Transigo" in the carrier app,
// invoices later) and the rules. Read with the admin's session (RLS: settings is admin-only).
export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

type Settings = Record<(typeof COMPANY_FIELDS)[number], string | null> & {
  free_cancellation_hours: number; late_cancellation_fee_bp: number; payout_window_hours: number; unassigned_alert_hours: number;
  updated_at: string;
};

const COMPANY_LABELS: { key: (typeof COMPANY_FIELDS)[number]; label: string; hint?: string; type?: string }[] = [
  { key: "company_name", label: "Ragione sociale" },
  { key: "company_vat_number", label: "Partita IVA", hint: "11 cifre" },
  { key: "company_fiscal_code", label: "Codice fiscale" },
  { key: "company_street", label: "Indirizzo sede legale" },
  { key: "company_postal_code", label: "CAP" },
  { key: "company_city", label: "Città" },
  { key: "company_province", label: "Provincia", hint: "sigla, es. MI" },
  { key: "company_email", label: "E-mail di contatto", type: "email" },
  { key: "company_phone", label: "Telefono", type: "tel" },
  { key: "company_pec", label: "PEC", type: "email" },
  { key: "company_sdi_code", label: "Codice SDI" },
];

async function Content() {
  await requireArea("admin", "/admin/impostazioni");
  const db = await createClient();
  const { data: s, error } = await db
    .from("settings")
    .select(`${COMPANY_FIELDS.join(", ")}, free_cancellation_hours, late_cancellation_fee_bp, payout_window_hours, unassigned_alert_hours, updated_at`)
    .single<Settings>();
  if (error || !s) throw new Error(`settings unavailable: ${error?.code}`);

  return (
    <AdminShell title="Impostazioni">
      <section aria-labelledby="company">
        <h2 id="company" className="mb-1 text-lg font-semibold text-zinc-900">Dati aziendali Transigo</h2>
        <p className="mb-3 text-sm text-zinc-600">Compaiono nel piè di pagina del sito (obbligatori: ragione sociale, sede legale, P.IVA), in «Contatta Transigo» dell&apos;app padroncini e nelle fatture.</p>
        <ActionForm action={updateCompanyAction} submitLabel="Salva dati aziendali" keepValues className="grid gap-3 sm:grid-cols-2">
          {COMPANY_LABELS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-zinc-800">{f.label}{f.hint ? <span className="font-normal text-zinc-500"> ({f.hint})</span> : null}</span>
              <input name={f.key} type={f.type ?? "text"} defaultValue={s[f.key] ?? ""} className={inputClass} />
            </label>
          ))}
        </ActionForm>
      </section>

      <section aria-labelledby="rules" className="mt-10">
        <h2 id="rules" className="mb-3 text-lg font-semibold text-zinc-900">Regole</h2>
        <ActionForm action={updateRulesAction} submitLabel="Salva regole" keepValues className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">Annullamento gratuito fino a (ore prima del ritiro)</span>
            <input name="free_cancellation_hours" inputMode="numeric" defaultValue={s.free_cancellation_hours} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">Penale per annullamento tardivo (%)</span>
            <input name="late_cancellation_fee_bp" inputMode="decimal" defaultValue={bpToPercentInput(s.late_cancellation_fee_bp)} className={inputClass} />
            <span className="text-xs text-zinc-500">Sul trasporto, facchini e imballaggio (il deposito si rimborsa sempre).</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">Pagamento al padroncino dopo la consegna (ore)</span>
            <input name="payout_window_hours" inputMode="numeric" defaultValue={s.payout_window_hours} className={inputClass} />
            <span className="text-xs text-zinc-500">Usato quando saranno attivi i pagamenti automatici.</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">Avviso ordini pagati senza padroncino dopo (ore)</span>
            <input name="unassigned_alert_hours" inputMode="numeric" defaultValue={s.unassigned_alert_hours} className={inputClass} />
            <span className="text-xs text-zinc-500">Nella dashboard.</span>
          </label>
        </ActionForm>
        <p className="mt-3 text-xs text-zinc-500">
          Le nuove regole di annullamento valgono per gli annullamenti da ora in poi. Distanza massima, preavviso, validità del preventivo:
          {" "}<Link href="/admin/area-di-servizio" className="text-blue-700 hover:underline">Area di servizio</Link>.
        </p>
      </section>
      <p className="mt-8 text-xs text-zinc-500">Ultima modifica: {new Date(s.updated_at).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" })}</p>
    </AdminShell>
  );
}
