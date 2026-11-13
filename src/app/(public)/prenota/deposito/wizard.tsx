"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AccountStep } from "@/components/booking/account-step";
import { BillingFields, EMPTY_BILLING, TermsCheckbox, type Billing } from "@/components/booking/billing-fields";
import { AddressField } from "@/components/address-field";
import { CHAIN_ROLE_LABEL } from "@/lib/orders/order-group";
import { isStorageOutOfArea, type PublicStorageQuote, type StorageError, type StorageStep } from "@/lib/booking/storage/messages";
import type { StorageOptions } from "@/lib/booking/storage/server";
import {
  EMPTY_STORAGE_STATE,
  endDateFor,
  parseStoredStorageState,
  STORAGE_MAX_PALLETS,
  STORAGE_STORAGE_KEY,
  STORAGE_WIZARD_PATH,
  storagePeriodDays,
  type ChainTransportState,
  type StoragePrefill,
  type StorageState,
} from "@/lib/booking/storage/state";
import { searchWarehouses } from "@/lib/booking/storage/warehouses";
import { accountStepError, initialWizardStep, wizardSteps, type WizardSession } from "@/lib/booking/session";
import { romeToday, TIME_WINDOW_LABEL, TIME_WINDOWS, type TimeWindow } from "@/lib/booking/windows";
import { formatCents } from "@/lib/pricing/money";
import { loadCheckoutDefaults } from "../actions";
import { Headline, PorterPicker, QuoteBreakdown } from "../quote-view";
import { submitStorageBooking } from "./actions";

// Deposito wizard (D153–D158). Same model as the other wizards: the state (no personal data) is kept in localStorage
// (D78); contacts and billing only in memory; every price and the availability come from the server (D76, D156).
// Payment: always the whole amount now (D172 — monthly installments come with step 10, without mention here).

const input = "mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-blue-500";
const label = "block text-sm font-medium text-zinc-800";

const ALL_STEPS: { id: StorageStep; label: string }[] = [
  { id: "magazzino", label: "Magazzino" },
  { id: "unita", label: "Cosa depositi" },
  { id: "periodo", label: "Periodo" },
  { id: "arrivo", label: "Arrivo della merce" },
  { id: "uscita", label: "Uscita della merce" },
  { id: "merce", label: "Merce" },
  { id: "facchini", label: "Facchini" },
  { id: "preventivo", label: "Preventivo" },
  { id: "account", label: "Account" },
  { id: "contatti", label: "Contatti" },
  { id: "riepilogo", label: "Riepilogo" },
];

type QuoteResponse =
  | { ok: true; customerType: "private" | "business"; quoteId: string; validUntil: string; quote: PublicStorageQuote }
  | { ok: false; customerType?: "private" | "business"; error: StorageError; message: string; step: StorageStep };

type Availability = { state: "idle" | "checking" } | { state: "result"; available: boolean } | { state: "error"; message: string };

type Contacts = { siteName: string; sitePhone: string; notes: string };
const EMPTY_CONTACTS: Contacts = { siteName: "", sitePhone: "", notes: "" };

async function post<T>(url: string, body: unknown, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

const OFFLINE = "Connessione non disponibile. Riprova.";
const fetchQuote = (state: StorageState) =>
  post<QuoteResponse>("/api/booking/storage-quote", { state }, { ok: false, error: { code: "pricing_unavailable" }, message: OFFLINE, step: "preventivo" });

const floorLabel = (n: number) => (n === 0 ? "Piano terra" : `${n}° piano`);
const dateIt = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" }) : "");

export function StorageWizard({ options, session, initialStep, prefill }: { options: StorageOptions; session: WizardSession; initialStep: string | null; prefill: StoragePrefill }) {
  const [state, setState] = useState<StorageState>(EMPTY_STORAGE_STATE);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<StorageStep>("magazzino");
  const [maxStep, setMaxStep] = useState(0);
  const [contacts, setContacts] = useState<Contacts>(EMPTY_CONTACTS);
  const [billing, setBilling] = useState<Billing>(EMPTY_BILLING);
  const [billingLoaded, setBillingLoaded] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [availability, setAvailability] = useState<Availability>({ state: "idle" });
  const [stepError, setStepError] = useState<string | null>(null);
  const [outOfArea, setOutOfArea] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; number: string; paymentError: string | null } | null>(null);
  const [submitting, startSubmit] = useTransition();
  const quoteSeq = useRef(0);
  const availSeq = useRef(0);
  const prefillDays = useRef(prefill.days);
  const [warehouseQuery, setWarehouseQuery] = useState("");
  const warehouse = options.warehouses.find((w) => w.id === state.warehouseId) ?? null;

  const customerType = session.kind === "customer" ? session.customerType : state.customerTypeView;
  const isPrivate = customerType === "private";
  const withTransport = state.intake === "transigo" || state.outbound === "transigo";
  const steps = useMemo(() => wizardSteps(ALL_STEPS, session).filter((s) => s.id !== "facchini" || (withTransport && options.porterPackages.length > 0)), [withTransport, options.porterPackages.length, session]);
  const stepIndex = useCallback((id: StorageStep) => {
    const i = steps.findIndex((s) => s.id === id);
    return i >= 0 ? i : ALL_STEPS.findIndex((s) => s.id === id);
  }, [steps]);

  // Restore after mount; values from the calculator link win over the stored unit (D162).
  useEffect(() => {
    let restored: StorageState | null = null;
    try {
      restored = parseStoredStorageState(window.localStorage.getItem(STORAGE_STORAGE_KEY));
    } catch {
      /* storage blocked: start empty */
    }
    let base = restored ?? EMPTY_STORAGE_STATE;
    if (prefill.boxCode) base = { ...base, customerTypeView: "private", boxCode: prefill.boxCode };
    else if (prefill.pallets) base = { ...base, customerTypeView: "business", pallets: prefill.pallets };
    if (prefill.days && base.startDate) base = { ...base, endDate: endDateFor(base.startDate, prefill.days) };
    // D178: a warehouse that is no longer offered is dropped; with only one, it is picked for the customer.
    if (!options.warehouses.some((w) => w.id === base.warehouseId)) base = { ...base, warehouseId: options.warehouses.length === 1 ? options.warehouses[0].id : null };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from localStorage after hydration
    setState(base);
    const start = initialWizardStep(initialStep, session, "contatti");
    if (restored && start && ALL_STEPS.some((s) => s.id === start)) {
      setStep(start as StorageStep);
      setMaxStep(ALL_STEPS.findIndex((s) => s.id === start));
    }
    // A page kept alive by the router (sign-in and back) gets a new session: no stale "Accedi o registrati" error.
    setStepError(null);
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on mount, and again when the URL or the session changes
  }, [initialStep, prefill.boxCode, prefill.pallets, prefill.days, session.kind]);

  useEffect(() => {
    if (!loaded || created) return;
    try {
      window.localStorage.setItem(STORAGE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, loaded, created]);

  const update = useCallback((patch: Partial<StorageState>) => {
    // The calculator's number of days fills the end date once the start is chosen (D162). Read outside the
    // updater: React may call an updater twice.
    const days = "startDate" in patch && patch.startDate ? prefillDays.current : undefined;
    if (days) prefillDays.current = undefined;
    setState((s) => ({ ...s, ...patch, ...(days && patch.startDate && !s.endDate ? { endDate: endDateFor(patch.startDate, days) } : {}) }));
    setStepError(null);
    setOutOfArea(false);
  }, []);
  const updateTransport = (role: "intake" | "outbound", patch: Partial<ChainTransportState>) =>
    update(role === "intake" ? { intakeTransport: { ...state.intakeTransport, ...patch } } : { outboundTransport: { ...state.outboundTransport, ...patch } });

  const runQuote = useCallback(async (s: StorageState) => {
    const seq = ++quoteSeq.current;
    setQuoting(true);
    const result = await fetchQuote(s);
    if (seq !== quoteSeq.current) return result;
    setQuote(result);
    setQuoting(false);
    return result;
  }, []);

  // Live availability while the customer picks the unit and the dates (D156): yes / no only.
  const periodReady = !!(state.warehouseId && state.startDate && state.endDate && (isPrivate ? state.boxCode : state.pallets));
  useEffect(() => {
    if (!loaded || !periodReady || created) return;
    const seq = ++availSeq.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- shows "checking" until the server answers
    setAvailability({ state: "checking" });
    const t = setTimeout(async () => {
      const r = await post<{ ok: true; available: boolean } | { ok: false; message: string }>("/api/booking/storage-availability", { state }, { ok: false, message: OFFLINE });
      if (seq !== availSeq.current) return;
      setAvailability(r.ok ? { state: "result", available: r.available } : { state: "error", message: r.message });
    }, 400);
    return () => clearTimeout(t);
  }, [state.warehouseId, state.startDate, state.endDate, state.boxCode, state.pallets, state.customerTypeView, periodReady, loaded, created]); // eslint-disable-line react-hooks/exhaustive-deps -- only warehouse, unit and period matter

  useEffect(() => {
    if (!loaded || !periodReady || stepIndex(step) < stepIndex("merce") || created) return;
    const t = setTimeout(() => void runQuote(state), 500);
    return () => clearTimeout(t);
  }, [state, step, loaded, runQuote, created, periodReady, stepIndex]);

  useEffect(() => {
    if (step !== "riepilogo" || billingLoaded || session.kind !== "customer") return;
    void loadCheckoutDefaults().then((d) => {
      if (d) setBilling((b) => (Object.values(b).some(Boolean) ? b : { ...EMPTY_BILLING, ...d.billing }));
      setBillingLoaded(true);
    });
  }, [step, billingLoaded, session.kind]);

  const selected = quote?.ok ? quote : null;
  const display = selected?.quote.display ?? (isPrivate ? "gross" : "net_plus_vat");
  const days = storagePeriodDays(state);

  const go = (to: StorageStep) => {
    setStep(to);
    setMaxStep((m) => Math.max(m, stepIndex(to)));
    setStepError(null);
    setNotice(null);
    setOutOfArea(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** Server check: errors of this step or an earlier one block "Avanti". */
  async function blockingError(): Promise<string | null> {
    const result = await runQuote(state);
    setOutOfArea(!result.ok && isStorageOutOfArea(result.error));
    if (result.ok) return null;
    return stepIndex(result.step) <= stepIndex(step) ? result.message : null;
  }

  const transportMissing = (t: ChainTransportState) => (!t.place ? "Seleziona l'indirizzo dall'elenco." : !t.window ? "Scegli la fascia oraria." : null);

  async function next() {
    setStepError(null);
    let error: string | null = null;
    switch (step) {
      case "magazzino":
        error = state.warehouseId ? null : "Scegli il magazzino.";
        break;
      case "unita":
        error = isPrivate ? (state.boxCode ? null : "Scegli la misura del box.") : state.pallets ? null : "Indica il numero di pallet.";
        break;
      case "periodo":
        if (!state.startDate || !state.endDate) error = "Scegli le date di inizio e fine.";
        else if (!days) error = "La data di fine non può essere prima dell'inizio.";
        else if (availability.state === "result" && !availability.available) error = "Non ci sono posti liberi per queste date.";
        else error = await blockingError();
        break;
      case "arrivo":
        error = (state.intake === "transigo" ? transportMissing(state.intakeTransport) : null) ?? (state.intake === "transigo" ? await blockingError() : null);
        break;
      case "uscita":
        error = (state.outbound === "transigo" ? transportMissing(state.outboundTransport) : null) ?? (state.outbound === "transigo" ? await blockingError() : null);
        break;
      case "merce":
        error = state.goods.description.trim() ? await blockingError() : "Descrivi cosa vuoi depositare.";
        break;
      case "facchini":
        error = await blockingError();
        break;
      case "preventivo":
        if (!selected) error = quoting ? "Il preventivo non è ancora pronto." : quote && !quote.ok ? quote.message : "Il preventivo non è ancora pronto.";
        break;
      case "account":
        error = accountStepError(session);
        break;
      case "contatti":
        if (withTransport && (!contacts.siteName.trim() || !contacts.sitePhone.trim())) error = "Inserisci nome e telefono della persona presente al ritiro o alla consegna.";
        break;
    }
    if (error) {
      setStepError(error);
      return;
    }
    const nextStep = steps[stepIndex(step) + 1]?.id;
    if (nextStep) go(nextStep);
  }

  function confirm() {
    if (!selected) return;
    setFieldErrors({});
    setStepError(null);
    startSubmit(async () => {
      const result = await submitStorageBooking({ state, quoteId: selected.quoteId, shownTotalCents: selected.quote.totalCents, contacts, billing, acceptTerms });
      switch (result.status) {
        case "created":
          try {
            window.localStorage.removeItem(STORAGE_STORAGE_KEY); // D78
          } catch {
            /* ignore */
          }
          if (result.payment && "url" in result.payment) {
            window.location.assign(result.payment.url); // Stripe Checkout; "paid" only after the webhook
            return;
          }
          setCreated({ id: result.orderId, number: result.orderNumber, paymentError: result.payment && "error" in result.payment ? result.payment.error : null });
          setContacts(EMPTY_CONTACTS);
          setBilling(EMPTY_BILLING);
          window.scrollTo({ top: 0 });
          break;
        case "price_changed":
          setQuote((q) => ({ ok: true, customerType: q?.customerType ?? customerType, quoteId: result.quoteId, validUntil: result.validUntil, quote: result.quote }));
          setNotice(result.message);
          break;
        case "redirect":
          window.location.assign(result.to);
          break;
        case "invalid":
          setFieldErrors(result.fieldErrors);
          setStepError(result.message ?? "Controlla i campi evidenziati.");
          if (Object.keys(result.fieldErrors).some((k) => k.startsWith("contacts."))) go("contatti");
          break;
        case "error":
          if (result.step && stepIndex(result.step) < stepIndex("riepilogo")) go(result.step);
          setStepError(result.message);
          break;
      }
    });
  }

  if (!loaded) return <p className="py-10 text-center text-sm text-zinc-500">Caricamento…</p>;

  if (created) {
    return (
      <div className="mt-6 rounded-lg border border-green-200 bg-green-50 p-6">
        <h2 className="text-xl font-semibold text-green-900">Prenotazione registrata</h2>
        <p className="mt-2 text-green-900">Numero ordine: <strong>{created.number}</strong></p>
        <p className="mt-2 text-sm text-green-900">Stato: In attesa di pagamento.</p>
        {created.paymentError ? <p className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">{created.paymentError}</p> : null}
        <Link href={`/cliente/ordini/${created.id}`} className="mt-4 inline-block rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700">Vai all&apos;ordine e paga</Link>
      </div>
    );
  }

  const fe = (k: string) => fieldErrors[k];
  const box = options.boxes.find((b) => b.code === state.boxCode) ?? null;
  const unitText = isPrivate ? (box ? `${box.labelIt} (${box.volumeM3} m³)` : "") : state.pallets ? `${state.pallets} pallet` : "";
  const partTerms = (role: "intake" | "outbound") => selected?.quote.parts.find((p) => p.role === role)?.quote.porters[0];

  const transportFields = (role: "intake" | "outbound") => {
    const t = role === "intake" ? state.intakeTransport : state.outboundTransport;
    const date = role === "intake" ? state.startDate : state.endDate;
    return (
      <div className="mt-4 space-y-4 rounded-md border border-zinc-200 p-4">
        <AddressField
          id={`addr-${role}`}
          label={role === "intake" ? "Indirizzo di ritiro" : "Indirizzo di consegna"}
          value={t.place}
          onChange={(p) => updateTransport(role, { place: p ? { floor: t.place?.floor ?? 0, hasElevator: t.place?.hasElevator ?? false, ...p } : null })}
        />
        {t.place ? (
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label htmlFor={`${role}-floor`} className={label}>Piano</label>
              <select id={`${role}-floor`} value={t.place.floor} onChange={(e) => updateTransport(role, { place: { ...t.place!, floor: Number(e.target.value) } })} className={`${input} w-36`}>
                {Array.from({ length: 21 }, (_, n) => <option key={n} value={n}>{floorLabel(n)}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" checked={t.place.hasElevator} onChange={(e) => updateTransport(role, { place: { ...t.place!, hasElevator: e.target.checked } })} />
              Ascensore disponibile
            </label>
          </div>
        ) : null}
        <div>
          <label htmlFor={`${role}-window`} className={label}>
            Fascia oraria il {dateIt(date)} <span className="text-red-600">*</span>
          </label>
          <select id={`${role}-window`} value={t.window ?? ""} onChange={(e) => updateTransport(role, { window: (e.target.value || null) as TimeWindow | null })} className={`${input} w-48`}>
            <option value="">Scegli…</option>
            {TIME_WINDOWS.map((w) => <option key={w} value={w}>{TIME_WINDOW_LABEL[w]}</option>)}
          </select>
          <p className="mt-1 text-xs text-zinc-500">
            {role === "intake" ? "Il ritiro avviene il primo giorno del deposito." : "La consegna avviene l'ultimo giorno del deposito."} Prenota almeno {options.minLeadHours} ore prima.
          </p>
        </div>
      </div>
    );
  };

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div>
        <ol className="mb-6 flex flex-wrap gap-2 text-xs" aria-label="Passaggi">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                disabled={i > maxStep}
                onClick={() => go(s.id)}
                aria-current={s.id === step ? "step" : undefined}
                className={`rounded-full px-3 py-1 ${s.id === step ? "bg-blue-600 text-white" : i <= maxStep ? "bg-blue-50 text-blue-800 hover:bg-blue-100" : "bg-zinc-100 text-zinc-400"}`}
              >
                {i + 1}. {s.label}
              </button>
            </li>
          ))}
        </ol>

        <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-zinc-900">{ALL_STEPS.find((s) => s.id === step)?.label}</h2>

          {step === "magazzino" ? (
            <div className="space-y-4">
              <div>
                <label htmlFor="warehouse-search" className={label}>In quale città ti serve il deposito?</label>
                <input id="warehouse-search" type="search" autoComplete="off" value={warehouseQuery} onChange={(e) => setWarehouseQuery(e.target.value)} placeholder="Es. Milano, Bologna" className={`${input} sm:w-80`} />
              </div>
              {(() => {
                const found = searchWarehouses(options.warehouses, warehouseQuery);
                if (!found.length) {
                  return (
                    <p className="rounded-md bg-zinc-50 p-3 text-sm text-zinc-700">
                      Nessun magazzino a «{warehouseQuery.trim()}». Magazzini disponibili: {[...new Set(options.warehouses.map((w) => w.city))].join(", ")}.{" "}
                      <Link className="text-blue-700 underline" href="/contatti?servizio=deposito">Scrivici</Link> per altre città.
                    </p>
                  );
                }
                return (
                  <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Magazzini">
                    {found.map((w) => {
                      const chosen = state.warehouseId === w.id;
                      return (
                        <div key={w.id} className={`rounded-lg border p-4 ${chosen ? "border-blue-600 bg-blue-50 ring-2 ring-blue-600" : "border-zinc-300 hover:border-blue-400"}`}>
                          <button type="button" role="radio" aria-checked={chosen} onClick={() => update({ warehouseId: w.id })} className="block w-full text-left">
                            <span className="block font-semibold text-zinc-900">{w.city} ({w.province})</span>
                            <span className="mt-0.5 block text-sm text-zinc-700">{w.name}</span>
                            <span className="mt-1 block text-xs text-zinc-600">{w.address}</span>
                          </button>
                          <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(w.address)}`} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-blue-700 underline">
                            Vedi sulla mappa
                          </a>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          ) : null}

          {step === "unita" ? (
            <div className="space-y-4">
              {session.kind === "customer" ? (
                <p className="text-sm text-zinc-600">{isPrivate ? "Per i privati: box di diverse misure." : "Per le aziende: posti pallet."}</p>
              ) : (
                <fieldset>
                  <legend className="text-sm text-zinc-700">Prenoti come</legend>
                  <div className="mt-1 flex flex-wrap gap-4">
                    {(["private", "business"] as const).map((t) => (
                      <label key={t} className="flex items-center gap-2 text-sm">
                        <input type="radio" name="customerTypeView" checked={state.customerTypeView === t} onChange={() => update({ customerTypeView: t })} />
                        {t === "private" ? "Privato – box" : "Azienda – pallet"}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              {isPrivate ? (
                options.boxes.length ? (
                  <fieldset>
                    <legend className={label}>Misura del box</legend>
                    <div className="mt-2 grid gap-3 sm:grid-cols-3">
                      {options.boxes.map((b) => (
                        <label key={b.code} className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm ${state.boxCode === b.code ? "border-blue-600 bg-blue-50" : "border-zinc-300"}`}>
                          <span className="flex items-center gap-2 font-medium">
                            <input type="radio" name="box" checked={state.boxCode === b.code} onChange={() => update({ boxCode: b.code })} />
                            {b.labelIt}
                          </span>
                          <span className="text-zinc-600">{b.volumeM3} m³</span>
                          <span className="text-zinc-600">
                            {formatCents(b.monthCents + Math.round((b.monthCents * options.vatRateBp) / 10_000))} al mese IVA inclusa
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">Prezzo al mese per periodi di 30 giorni; i giorni in più costano al massimo come un mese.</p>
                  </fieldset>
                ) : (
                  <p className="text-sm text-amber-800">I box per privati non sono prenotabili online al momento. <a href="/contatti" className="underline">Contattaci</a>.</p>
                )
              ) : options.pallets ? (
                <div>
                  <label htmlFor="pallets" className={label}>Numero di pallet (EUR 80×120)</label>
                  <input id="pallets" type="number" inputMode="numeric" min={1} max={STORAGE_MAX_PALLETS} value={state.pallets ?? ""} onChange={(e) => update({ pallets: e.target.value ? Math.min(STORAGE_MAX_PALLETS, Math.max(1, Math.floor(Number(e.target.value)))) : null })} className={`${input} w-32`} />
                </div>
              ) : (
                <p className="text-sm text-amber-800">Il deposito pallet non è prenotabile online al momento. <a href="/contatti" className="underline">Contattaci</a>.</p>
              )}
            </div>
          ) : null}

          {step === "periodo" ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-4">
                <div>
                  <label htmlFor="start" className={label}>Inizio <span className="text-red-600">*</span></label>
                  <input id="start" type="date" min={romeToday()} value={state.startDate ?? ""} onChange={(e) => update({ startDate: e.target.value || null })} className={`${input} w-48`} />
                </div>
                <div>
                  <label htmlFor="end" className={label}>Fine <span className="text-red-600">*</span></label>
                  <input id="end" type="date" min={state.startDate ?? romeToday()} value={state.endDate ?? ""} onChange={(e) => update({ endDate: e.target.value || null })} className={`${input} w-48`} />
                </div>
              </div>
              {days ? <p className="text-sm text-zinc-700">Durata: {days} {days === 1 ? "giorno" : "giorni"} (inizio e fine compresi).</p> : null}
              {periodReady ? (
                <p role="status" className={`rounded-md p-3 text-sm ${availability.state === "result" ? (availability.available ? "bg-green-50 text-green-900" : "bg-red-50 text-red-700") : "bg-zinc-50 text-zinc-600"}`}>
                  {availability.state === "result"
                    ? availability.available ? `Disponibile: ${unitText} libero per tutto il periodo.` : "Non disponibile per queste date. Prova con altre date o un'altra misura."
                    : availability.state === "error" ? availability.message : "Verifica della disponibilità…"}
                </p>
              ) : null}
              <p className="text-xs text-zinc-500">Il deposito ha una data di fine: potrai prolungarlo se il posto resta libero.</p>
            </div>
          ) : null}

          {step === "arrivo" ? (
            <fieldset>
              <legend className={label}>Come arriva la merce in magazzino?</legend>
              <div className="mt-2 space-y-2">
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="intake" className="mt-1" checked={state.intake === "self"} onChange={() => update({ intake: "self" })} />
                  <span>La porto io{warehouse ? ` al magazzino di ${warehouse.city}` : ""} il {dateIt(state.startDate)}{warehouse ? <span className="block text-xs text-zinc-500">{warehouse.address}</span> : null}</span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="intake" className="mt-1" checked={state.intake === "transigo"} onChange={() => update({ intake: "transigo" })} />
                  <span>Ritiro Transigo: veniamo noi a prendere la merce</span>
                </label>
              </div>
              {state.intake === "transigo" ? transportFields("intake") : null}
            </fieldset>
          ) : null}

          {step === "uscita" ? (
            <fieldset>
              <legend className={label}>Come esce la merce alla fine del deposito?</legend>
              <div className="mt-2 space-y-2">
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="outbound" className="mt-1" checked={state.outbound === "self"} onChange={() => update({ outbound: "self" })} />
                  <span>La ritiro io il {dateIt(state.endDate)}</span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="outbound" className="mt-1" checked={state.outbound === "transigo"} onChange={() => update({ outbound: "transigo" })} />
                  <span>Consegna Transigo: la portiamo noi all&apos;indirizzo che scegli</span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="outbound" className="mt-1" checked={state.outbound === "later"} onChange={() => update({ outbound: "later" })} />
                  <span>Lo deciderò più avanti<span className="block text-xs text-zinc-500">Potrai prenotare la consegna in seguito, con un pagamento separato.</span></span>
                </label>
              </div>
              {state.outbound === "transigo" ? transportFields("outbound") : null}
            </fieldset>
          ) : null}

          {step === "merce" ? (
            <div className="space-y-4">
              <div>
                <label htmlFor="goods-desc" className={label}>Cosa depositi? <span className="text-red-600">*</span></label>
                <textarea id="goods-desc" rows={3} maxLength={2000} value={state.goods.description} onChange={(e) => update({ goods: { ...state.goods, description: e.target.value } })} className={input} placeholder="Es. mobili del soggiorno e 15 scatoloni" />
              </div>
              {withTransport ? (
                <>
                  <p className="text-sm text-zinc-600">Per il trasporto scegliamo noi il veicolo adatto in base al carico.</p>
                  <div className="flex flex-wrap gap-4">
                    <div>
                      <label htmlFor="goods-weight" className={label}>Peso totale indicativo (kg)</label>
                      <input id="goods-weight" type="number" inputMode="numeric" min={1} value={state.goods.weightKg ?? ""} onChange={(e) => update({ goods: { ...state.goods, weightKg: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null } })} className={`${input} w-40`} />
                    </div>
                    <div>
                      <label htmlFor="goods-items" className={label}>Numero di colli</label>
                      <input id="goods-items" type="number" inputMode="numeric" min={1} value={state.goods.itemsCount ?? ""} onChange={(e) => update({ goods: { ...state.goods, itemsCount: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null } })} className={`${input} w-32`} />
                    </div>
                  </div>
                  <fieldset>
                    <legend className={label}>Oggetto più grande (cm, facoltativo)</legend>
                    <div className="mt-1 flex gap-2">
                      {(["lengthCm", "widthCm", "heightCm"] as const).map((k) => (
                        <input
                          key={k}
                          aria-label={k === "lengthCm" ? "Lunghezza" : k === "widthCm" ? "Larghezza" : "Altezza"}
                          placeholder={k === "lengthCm" ? "Lungh." : k === "widthCm" ? "Largh." : "Alt."}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          value={state.goods.largestItem[k] ?? ""}
                          onChange={(e) => update({ goods: { ...state.goods, largestItem: { ...state.goods.largestItem, [k]: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null } } })}
                          className="w-full min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2 sm:w-24 sm:flex-none"
                        />
                      ))}
                    </div>
                  </fieldset>
                </>
              ) : null}
            </div>
          ) : null}

          {step === "facchini" ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-600">Facoltativo: facchini per caricare e scaricare la merce.</p>
              {state.intake === "transigo" ? (
                <PorterPicker id="porters-intake" title="Facchini al ritiro" value={state.intakeTransport.porters} onChange={(v) => updateTransport("intake", { porters: v })} options={options.porterPackages} terms={partTerms("intake")} display={display} />
              ) : null}
              {state.outbound === "transigo" ? (
                <PorterPicker id="porters-outbound" title="Facchini alla consegna" value={state.outboundTransport.porters} onChange={(v) => updateTransport("outbound", { porters: v })} options={options.porterPackages} terms={partTerms("outbound")} display={display} />
              ) : null}
            </div>
          ) : null}

          {step === "preventivo" ? (
            <div className="space-y-4">
              {selected ? (
                <>
                  {selected.quote.parts.map((p) => (
                    <div key={p.role}>
                      <h3 className="text-sm font-semibold text-zinc-900">
                        {CHAIN_ROLE_LABEL[p.role]}
                        {p.role === "storage" ? ` – ${unitText}, ${selected.quote.days} ${selected.quote.days === 1 ? "giorno" : "giorni"}` : p.distanceKm ? ` – ${p.distanceKm} km${p.vehicleName ? `, ${p.vehicleName}` : ""}` : ""}
                      </h3>
                      <QuoteBreakdown quote={p.quote} />
                    </div>
                  ))}
                  {selected.quote.parts.length > 1 ? (
                    <p className="border-t border-zinc-200 pt-3 text-right text-base font-semibold">
                      Totale da pagare: {formatCents(selected.quote.totalCents)}{display === "gross" ? " (IVA inclusa)" : ` (di cui IVA ${formatCents(selected.quote.vatCents)})`}
                    </p>
                  ) : null}
                  <p className="text-xs text-zinc-500">Pagamento unico alla prenotazione. Prezzo valido fino alle {new Date(selected.validUntil).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}; dopo, lo ricalcoliamo prima della conferma.</p>
                </>
              ) : (
                <p className="text-sm text-zinc-500">{quoting ? "Calcolo del preventivo…" : quote && !quote.ok ? quote.message : "Completa i passaggi precedenti per vedere il preventivo."}</p>
              )}
            </div>
          ) : null}

          {step === "account" ? <AccountStep session={session} returnTo={`${STORAGE_WIZARD_PATH}?passo=account`} /> : null}

          {step === "contatti" ? (
            <div className="space-y-4">
              {withTransport ? (
                <fieldset className="grid gap-4 sm:grid-cols-2">
                  <legend className="mb-2 text-sm font-medium text-zinc-800">Persona presente al ritiro / alla consegna</legend>
                  <div>
                    <label htmlFor="site-name" className={label}>Nome e cognome <span className="text-red-600">*</span></label>
                    <input id="site-name" autoComplete="name" maxLength={200} value={contacts.siteName} onChange={(e) => setContacts({ ...contacts, siteName: e.target.value })} className={input} />
                    {fe("contacts.siteName") ? <p className="mt-1 text-sm text-red-600">{fe("contacts.siteName")}</p> : null}
                  </div>
                  <div>
                    <label htmlFor="site-phone" className={label}>Telefono <span className="text-red-600">*</span></label>
                    <input id="site-phone" type="tel" autoComplete="tel" value={contacts.sitePhone} onChange={(e) => setContacts({ ...contacts, sitePhone: e.target.value })} className={input} />
                    {fe("contacts.sitePhone") ? <p className="mt-1 text-sm text-red-600">{fe("contacts.sitePhone")}</p> : null}
                  </div>
                </fieldset>
              ) : null}
              <div>
                <label htmlFor="storage-notes" className={label}>Note</label>
                <textarea id="storage-notes" rows={3} maxLength={2000} value={contacts.notes} onChange={(e) => setContacts({ ...contacts, notes: e.target.value })} className={input} placeholder={withTransport ? "Es. citofono, parcheggio, accesso al cortile" : "Es. orario in cui pensi di arrivare"} />
              </div>
            </div>
          ) : null}

          {step === "riepilogo" ? (
            <div className="space-y-6">
              <dl className="grid gap-2 text-sm sm:grid-cols-[11rem_1fr]">
                <dt className="text-zinc-500">Magazzino</dt>
                <dd>{warehouse ? `${warehouse.name}, ${warehouse.address}` : ""}</dd>
                <dt className="text-zinc-500">Deposito</dt>
                <dd>{unitText}</dd>
                <dt className="text-zinc-500">Periodo</dt>
                <dd>dal {dateIt(state.startDate)} al {dateIt(state.endDate)}{days ? ` (${days} ${days === 1 ? "giorno" : "giorni"})` : ""}</dd>
                <dt className="text-zinc-500">Arrivo</dt>
                <dd>{state.intake === "self" ? "La porto io" : `Ritiro Transigo: ${state.intakeTransport.place?.label ?? ""}, ${state.intakeTransport.window ? TIME_WINDOW_LABEL[state.intakeTransport.window] : ""}`}</dd>
                <dt className="text-zinc-500">Uscita</dt>
                <dd>{state.outbound === "self" ? "La ritiro io" : state.outbound === "later" ? "Lo deciderò più avanti" : `Consegna Transigo: ${state.outboundTransport.place?.label ?? ""}, ${state.outboundTransport.window ? TIME_WINDOW_LABEL[state.outboundTransport.window] : ""}`}</dd>
                <dt className="text-zinc-500">Merce</dt>
                <dd className="whitespace-pre-line">{state.goods.description}</dd>
              </dl>
              {selected ? (
                <p className="text-base">
                  Totale: <Headline cents={selected.quote.headlineCents} display={selected.quote.display} />
                </p>
              ) : null}
              <BillingFields business={session.kind === "customer" && session.customerType === "business"} billing={billing} setBilling={setBilling} errors={fieldErrors} />
              <TermsCheckbox checked={acceptTerms} onChange={setAcceptTerms} error={fe("acceptTerms")} />
              <p className="text-xs text-zinc-500">Dopo la conferma verrai indirizzato al pagamento sicuro con carta (Stripe). Paghi tutto in un&apos;unica soluzione, anche i trasporti.</p>
            </div>
          ) : null}

          {notice ? <p role="status" className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">{notice}</p> : null}
          {stepError ? <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{stepError}</p> : null}
          {outOfArea ? (
            <p className="mt-4 rounded-md border border-zinc-200 p-4 text-sm text-zinc-700">
              Stiamo ampliando le zone servite. <Link className="text-blue-700 underline" href="/contatti">Lasciaci una richiesta</Link>: ti ricontattiamo noi.
            </p>
          ) : null}

          <div className="mt-6 flex justify-between gap-3">
            <button type="button" disabled={stepIndex(step) === 0} onClick={() => go(steps[stepIndex(step) - 1].id)} className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 disabled:invisible">
              Indietro
            </button>
            {step === "riepilogo" ? (
              <button type="button" onClick={confirm} disabled={submitting || !selected} className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                {submitting ? "Attendere…" : "Conferma e paga"}
              </button>
            ) : (
              <button type="button" onClick={() => void next()} disabled={quoting && step !== "contatti" && step !== "account"} className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                Avanti
              </button>
            )}
          </div>
        </section>
      </div>

      <aside className="h-fit rounded-lg border border-zinc-200 bg-white p-4 shadow-sm lg:sticky lg:top-4" aria-live="polite">
        <h2 className="text-sm font-medium text-zinc-600">Il tuo preventivo</h2>
        {selected ? (
          <div className="mt-2">
            <Headline cents={selected.quote.headlineCents} display={selected.quote.display} />
            <p className="mt-1 text-xs text-zinc-500">{unitText} · {selected.quote.days} {selected.quote.days === 1 ? "giorno" : "giorni"}{selected.quote.parts.length > 1 ? " · trasporti inclusi" : ""}</p>
            {quoting ? <p className="text-xs text-zinc-400">Aggiornamento…</p> : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">{quoting ? "Calcolo…" : "Il prezzo comparirà dopo la scelta del periodo."}</p>
        )}
      </aside>
    </div>
  );
}
