import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { Loading } from "@/components/panel-shell";
import { ActionForm } from "@/components/admin/action-form";
import { AdminShell, inputClass } from "@/components/admin/admin-nav";
import { requireArea } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatBp, formatCents } from "@/lib/pricing/money";
import { KIND_LABEL, PORTER_PACKAGE_LABEL, RULE_META } from "@/lib/pricing/rule-meta";
import { PORTER_PACKAGE_CODES, PRICE_RULE_CODES, type PriceRuleKind } from "@/lib/pricing/types";
import { romeDate } from "@/lib/pricing/calendar";
import { deleteDraftAction, publishListAction, updateListSettingsAction, updatePackagesAction, updateRatesAction, updateRulesAction, updateStorageBoxesAction } from "../actions";
import { QuotePreview } from "../quote-preview";

export const metadata = { title: "Listino – Transigo" };

const STATUS = { draft: "Bozza", active: "Attivo", archived: "Archiviato" } as const;
const SECTIONS = ["Supplementi", "Servizi", "Deposito", "Quota padroncino"] as const;
/** Default preview pickup: in 2 days at 09:00 Italian time (request-time value, page is dynamic). */
function defaultPreviewPickup() {
  return `${romeDate(new Date(Date.now() + 2 * 86_400_000)).date}T09:00`;
}

const euro = (cents: number | null | undefined) => (cents == null ? "" : formatCents(cents).replace(" €", ""));

export default function Page({ params }: PageProps<"/admin/listini/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireArea("admin", `/admin/listini/${id}`);
  if (!z.uuid().safeParse(id).success) notFound();

  const db = await createClient();
  const [{ data: list }, { data: vehicles }, { data: rates }, { data: rules }, { data: packages }, { data: boxes }] = await Promise.all([
    db.from("price_lists").select("*").eq("id", id).maybeSingle(),
    db.from("vehicle_types").select("id, name_it, is_active, size_rank").order("size_rank"),
    db.from("price_list_vehicle_rates").select("vehicle_type_id, rate_per_km_cents, min_price_cents").eq("price_list_id", id),
    db.from("price_rules").select("code, kind, amount_cents, percent_bp, is_enabled").eq("price_list_id", id),
    db.from("price_list_porter_packages").select("code, porters_count, included_hours, is_enabled").eq("price_list_id", id),
    db.from("price_list_storage_boxes").select("code, label_it, volume_m3, day_cents, month_cents, sort_order, is_enabled").eq("price_list_id", id).order("sort_order").order("volume_m3"),
  ]);
  if (!list) notFound();

  const editable = list.status === "draft";
  const rateBy = new Map((rates ?? []).map((r) => [r.vehicle_type_id as string, r]));
  const ruleBy = new Map((rules ?? []).map((r) => [r.code as string, r]));
  const missingRates = (vehicles ?? []).filter((v) => v.is_active && !rateBy.has(v.id));
  const missingRules = PRICE_RULE_CODES.filter((c) => !ruleBy.has(c));
  const packageBy = new Map((packages ?? []).map((p) => [p.code as string, p]));
  const missingPackages = PORTER_PACKAGE_CODES.filter((c) => !packageBy.has(c));
  const hasPortersService = ruleBy.has("porters_floor_no_elevator");
  const enabledBoxes = (boxes ?? []).filter((b) => b.is_enabled).length;


  return (
    <AdminShell title={`Listino v${list.version} · ${STATUS[list.status as keyof typeof STATUS]}`}>
      {!editable ? <p className="mb-4 rounded-md bg-zinc-100 p-3 text-sm">Listino in sola lettura. Per modificarlo crea una bozza dalla pagina Listini.</p> : null}
      {editable && (missingRates.length || missingRules.length || missingPackages.length) ? (
        <p className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          Prima della pubblicazione completa:{" "}
          {[
            missingRates.length ? `tariffe per ${missingRates.map((v) => v.name_it).join(", ")}` : "",
            missingRules.length ? `${missingRules.length} regole` : "",
            missingPackages.length ? `${missingPackages.length} categorie facchinaggio` : "",
          ].filter(Boolean).join("; ")}.
        </p>
      ) : null}
      {!editable && missingPackages.length ? (
        <p className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">Questo listino non ha categorie facchinaggio: il facchinaggio non è prenotabile. Crea una bozza e pubblicala.</p>
      ) : null}
      {!editable && (!hasPortersService || !boxes?.length) ? (
        <p className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          Questo listino non ha {[!hasPortersService ? "le impostazioni del facchinaggio senza trasporto" : "", !boxes?.length ? "i box del deposito" : ""].filter(Boolean).join(" né ")}: questi servizi non sono prenotabili. Crea una bozza e pubblicala.
        </p>
      ) : null}
      {editable && !enabledBoxes ? (
        <p className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">Nessun box attivo: il deposito per privati non sarà prenotabile.</p>
      ) : null}

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Impostazioni</h2>
        <ActionForm action={updateListSettingsAction} submitLabel="Salva impostazioni" className={editable ? "" : "hidden"}>
          <input type="hidden" name="id" value={list.id} />
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <label className="flex flex-col gap-1">IVA (%)<input name="vat" defaultValue={formatBp(list.vat_rate_bp)} className={inputClass} /></label>
            <label className="flex flex-col gap-1">Urgente se ritiro entro (ore)<input name="urgent_lead_hours" defaultValue={list.urgent_lead_hours} className={inputClass} /></label>
            <label className="flex flex-col gap-1">Deposito breve fino a (giorni)<input name="storage_short_term_max_days" defaultValue={list.storage_short_term_max_days} className={inputClass} /></label>
            <label className="flex flex-col gap-1">Deposito: tariffa
              <select name="storage_billing_unit" defaultValue={list.storage_billing_unit} className={inputClass}>
                <option value="pallet_day">per pallet al giorno</option><option value="day">al giorno</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">Facchinaggio: tolleranza ore extra (min)<input name="porter_overtime_grace_minutes" defaultValue={list.porter_overtime_grace_minutes} className={inputClass} /></label>
            <label className="flex flex-col gap-1">Facchinaggio senza trasporto: ore minime<input name="porters_min_hours" defaultValue={list.porters_min_hours} className={inputClass} /></label>
            <label className="flex flex-col gap-1">Facchinaggio senza trasporto: persone minime (2–4)<input name="porters_min_persons" defaultValue={list.porters_min_persons} className={inputClass} /></label>
            <label className="col-span-2 flex flex-col gap-1 sm:col-span-4">Note<input name="notes" defaultValue={list.notes ?? ""} className={inputClass} /></label>
          </div>
        </ActionForm>
        {!editable ? (
          <p className="text-sm">
            IVA {formatBp(list.vat_rate_bp)}% · urgente entro {list.urgent_lead_hours} h · deposito breve fino a {list.storage_short_term_max_days} giorni ·
            tariffa deposito {list.storage_billing_unit === "day" ? "al giorno" : "per pallet al giorno"} ·
            tolleranza ore extra facchinaggio {list.porter_overtime_grace_minutes} min ·
            facchinaggio senza trasporto: minimo {list.porters_min_persons} persone × {list.porters_min_hours} h
          </p>
        ) : null}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Tariffe per veicolo</h2>
        <ActionForm action={updateRatesAction} submitLabel="Salva tariffe" hideSubmit={!editable}>
          <input type="hidden" name="id" value={list.id} />
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500"><tr><th className="py-1">Veicolo</th><th>€/km</th><th>Prezzo minimo (€)</th></tr></thead>
            <tbody>
              {(vehicles ?? []).filter((v) => v.is_active || rateBy.has(v.id)).map((v) => {
                const r = rateBy.get(v.id);
                return (
                  <tr key={v.id} className="border-t border-zinc-100">
                    <td className="py-1">{v.name_it}{v.is_active ? "" : " (non attivo)"}<input type="hidden" name="vehicle_type_id" value={v.id} /></td>
                    <td><input name={`rate_${v.id}`} defaultValue={euro(r?.rate_per_km_cents)} disabled={!editable} className={`${inputClass} w-24`} /></td>
                    <td><input name={`min_${v.id}`} defaultValue={euro(r?.min_price_cents)} disabled={!editable} className={`${inputClass} w-24`} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ActionForm>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Facchinaggio – categorie</h2>
        <ActionForm action={updatePackagesAction} submitLabel="Salva categorie" hideSubmit={!editable}>
          <input type="hidden" name="id" value={list.id} />
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500"><tr><th className="py-1">Categoria</th><th>Persone (minimo)</th><th>Ore incluse</th><th /></tr></thead>
            <tbody>
              {PORTER_PACKAGE_CODES.map((code) => {
                const p = packageBy.get(code);
                return (
                  <tr key={code} className="border-t border-zinc-100">
                    <td className="py-1">{PORTER_PACKAGE_LABEL[code]}</td>
                    <td><input name={`persons_${code}`} defaultValue={p?.porters_count ?? ""} disabled={!editable} className={`${inputClass} w-16`} /></td>
                    <td><input name={`hours_${code}`} defaultValue={p?.included_hours ?? ""} disabled={!editable} className={`${inputClass} w-16`} /></td>
                    <td><label className="flex items-center gap-1"><input type="checkbox" name={`enabled_${code}`} defaultChecked={p?.is_enabled ?? true} disabled={!editable} /> attiva</label></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-zinc-500">Prezzo = persone × ore incluse × tariffa «Facchinaggio (ore incluse)». Il cliente può aggiungere persone (max 4), non ore. Ore extra: regola «ora extra iniziata», oltre la tolleranza.</p>
        </ActionForm>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Deposito – box per privati</h2>
        <ActionForm action={updateStorageBoxesAction} submitLabel="Salva box" hideSubmit={!editable}>
          <input type="hidden" name="id" value={list.id} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-zinc-500"><tr><th className="py-1">Codice</th><th>Nome</th><th>m³</th><th>€/giorno</th><th>€/mese</th><th>Ordine</th><th /></tr></thead>
              <tbody>
                {(boxes ?? []).map((b) => (
                  <tr key={b.code} className="border-t border-zinc-100">
                    <td className="py-1 font-mono">{b.code}<input type="hidden" name="box_code" value={b.code} /></td>
                    <td><input name={`label_${b.code}`} defaultValue={b.label_it} disabled={!editable} className={`${inputClass} w-32`} /></td>
                    <td><input name={`volume_${b.code}`} defaultValue={String(b.volume_m3).replace(".", ",")} disabled={!editable} className={`${inputClass} w-16`} /></td>
                    <td><input name={`day_${b.code}`} defaultValue={euro(b.day_cents)} disabled={!editable} className={`${inputClass} w-20`} /></td>
                    <td><input name={`month_${b.code}`} defaultValue={euro(b.month_cents)} disabled={!editable} className={`${inputClass} w-20`} /></td>
                    <td><input name={`order_${b.code}`} defaultValue={b.sort_order} disabled={!editable} className={`${inputClass} w-14`} /></td>
                    <td><label className="flex items-center gap-1"><input type="checkbox" name={`enabled_${b.code}`} defaultChecked={b.is_enabled} disabled={!editable} /> attivo</label></td>
                  </tr>
                ))}
                {editable ? (
                  <tr className="border-t border-zinc-200">
                    <td className="py-1"><input name="new_code" placeholder="nuovo" className={`${inputClass} w-20 font-mono`} /></td>
                    <td><input name="label_new" placeholder="Box XL" className={`${inputClass} w-32`} /></td>
                    <td><input name="volume_new" className={`${inputClass} w-16`} /></td>
                    <td><input name="day_new" className={`${inputClass} w-20`} /></td>
                    <td><input name="month_new" className={`${inputClass} w-20`} /></td>
                    <td><input name="order_new" className={`${inputClass} w-14`} /></td>
                    <td><label className="flex items-center gap-1"><input type="checkbox" name="enabled_new" defaultChecked /> attivo</label></td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs text-zinc-500">Prezzo = mesi interi (30 giorni) × €/mese + giorni restanti × €/giorno; i giorni restanti non costano più di un mese. Il codice non si può cambiare: per togliere un box disattivalo. Per aggiungerne uno compila l&apos;ultima riga.</p>
        </ActionForm>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Supplementi, servizi, deposito e quota padroncino</h2>
        <ActionForm action={updateRulesAction} submitLabel="Salva regole" hideSubmit={!editable}>
          <input type="hidden" name="id" value={list.id} />
          {SECTIONS.map((section) => (
            <div key={section} className="mb-4">
              <h3 className="text-sm font-semibold text-zinc-600">{section}</h3>
              <table className="w-full text-sm">
                <tbody>
                  {PRICE_RULE_CODES.filter((c) => RULE_META[c].section === section).map((code) => {
                    const meta = RULE_META[code];
                    const r = ruleBy.get(code);
                    const kind = (r?.kind ?? meta.kinds[0]) as PriceRuleKind;
                    const value = r ? (r.kind === "percent" ? formatBp(r.percent_bp ?? 0) : euro(r.amount_cents)) : "";
                    return (
                      <tr key={code} className="border-t border-zinc-100">
                        <td className="w-1/2 py-1">{meta.label}{meta.unit ? <span className="text-zinc-500"> (per {meta.unit})</span> : null}</td>
                        <td>
                          <select name={`kind_${code}`} defaultValue={kind} disabled={!editable} className={inputClass}>
                            {meta.kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                          </select>
                        </td>
                        <td><input name={`value_${code}`} defaultValue={value} disabled={!editable} className={`${inputClass} w-24`} /></td>
                        <td><label className="flex items-center gap-1"><input type="checkbox" name={`enabled_${code}`} defaultChecked={r?.is_enabled ?? true} disabled={!editable} /> attivo</label></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
          <p className="text-xs text-zinc-500">Percentuali con al massimo 2 decimali (es. 12,5). Importi in euro (es. 1,40). La quota padroncino si calcola sul netto.</p>
        </ActionForm>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Anteprima preventivo</h2>
        <QuotePreview
          priceListId={list.id}
          vehicles={(vehicles ?? []).filter((v) => v.is_active).map((v) => ({ id: v.id, name: v.name_it }))}
          defaultPickup={defaultPreviewPickup()}
        />
      </section>

      {editable ? (
        <section className="flex flex-wrap gap-6 border-t border-zinc-200 pt-4">
          <ActionForm action={publishListAction} submitLabel="Pubblica listino">
            <input type="hidden" name="id" value={list.id} />
          </ActionForm>
          <ActionForm action={deleteDraftAction} submitLabel="Elimina bozza" variant="danger">
            <input type="hidden" name="id" value={list.id} />
          </ActionForm>
        </section>
      ) : null}
    </AdminShell>
  );
}
