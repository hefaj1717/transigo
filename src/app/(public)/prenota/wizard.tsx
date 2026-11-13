"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { formatCents } from "@/lib/pricing/money";
import { isOutOfArea, type BookingStep } from "@/lib/booking/messages";
import type { BookingOptions } from "@/lib/booking/server";
import { EMPTY_WIZARD_STATE, goodsStepError, isStackableCategory, parseStoredState, transportOnly, WIZARD_STORAGE_KEY, type PlaceChoice, type ShipmentCategory, type WizardState } from "@/lib/booking/state";
import { romeToday, TIME_WINDOW_LABEL, TIME_WINDOWS, type TimeWindow } from "@/lib/booking/windows";
import { loadCheckoutDefaults, submitBooking } from "./actions";
import { createQuoteMemo, keepQuoteResult } from "@/lib/booking/quote-memo";
import { AccountStep } from "@/components/booking/account-step";
import { useScrollTopOnStep } from "@/components/booking/use-step-scroll";
import { BillingFields, EMPTY_BILLING, TermsCheckbox, type Billing } from "@/components/booking/billing-fields";
import { accountStepError, initialWizardStep, wizardSteps } from "@/lib/booking/session";
import { AddressField } from "@/components/address-field";
import { ContactForm } from "@/components/contact-form";
import { SHIPMENT_LABEL } from "@/lib/orders/shipment";
import { sendOutOfAreaAction } from "./out-of-area-actions";
import { Headline, QuoteBreakdown } from "./quote-view";
import { LoadingHelpField } from "@/components/booking/loading-help-field";
import { VehicleIllustration } from "@/components/site/vehicle-illustration";
import { STEPS, type QuoteResponse, type WizardSession } from "./types";
import { bookingDateLabel } from "@/lib/booking/date-label";

const input = "mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-blue-500";
const label = "block text-sm font-medium text-zinc-800";

/** D176: what the customer ships (zipmend-like), instead of the move type. */
const SHIPMENT_OPTIONS: { id: ShipmentCategory; label: string; hint: string; example: string }[] = [
  { id: "pallet", label: SHIPMENT_LABEL.pallet, hint: "EUR 120 × 80 cm", example: "Es. bancali di piastrelle" },
  { id: "package", label: SHIPMENT_LABEL.package, hint: "Scatole, mobili, oggetti", example: "Es. 10 scatoloni e una lavatrice" },
  { id: "document", label: SHIPMENT_LABEL.document, hint: "Buste e plichi", example: "Es. contratti firmati" },
  { id: "gitterbox", label: SHIPMENT_LABEL.gitterbox, hint: "124 × 84 × 97 cm", example: "Es. gitterbox con ricambi" },
  { id: "full_vehicle", label: SHIPMENT_LABEL.full_vehicle, hint: "Scegli tu il mezzo", example: "Es. merce varia per un negozio" },
];

type Contacts = { pickupName: string; pickupPhone: string; deliveryName: string; deliveryPhone: string; notes: string };
const EMPTY_CONTACTS: Contacts = { pickupName: "", pickupPhone: "", deliveryName: "", deliveryPhone: "", notes: "" };

const intOrNull = (v: string) => (v.trim() === "" ? null : Math.max(0, Math.trunc(Number(v))) || null);

async function fetchQuote(state: WizardState, probe = false): Promise<QuoteResponse> {
  try {
    const res = await fetch("/api/booking/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, probe }),
    });
    return (await res.json()) as QuoteResponse;
  } catch {
    return { ok: false, error: { code: "pricing_unavailable" }, message: "Connessione non disponibile. Riprova.", step: "preventivo" };
  }
}

/** Enough data to price the order (addresses + pickup date and window). */
const canQuote = (s: WizardState) => !!(s.pickup && s.delivery && s.pickupDate && s.pickupWindow);

export function Wizard({ options, session, initialStep }: { options: BookingOptions; session: WizardSession; initialStep: string | null }) {
  // --- state ---------------------------------------------------------------------------------------------
  // Route, schedule, goods and services: kept in localStorage (D78). Contacts and billing: memory only.
  const [state, setState] = useState<WizardState>(EMPTY_WIZARD_STATE);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<BookingStep>("percorso");
  const requestScrollTop = useScrollTopOnStep(step);
  const [maxStep, setMaxStep] = useState(0);
  const [contacts, setContacts] = useState<Contacts>(EMPTY_CONTACTS);
  const [billing, setBilling] = useState<Billing>(EMPTY_BILLING);
  const [billingLoaded, setBillingLoaded] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  /** The route is outside the service area (spec 2a): show the "out of area" contact form (D125). */
  const [outOfArea, setOutOfArea] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; number: string; paymentError: string | null } | null>(null);
  const [submitting, startSubmit] = useTransition();
  const quoteSeq = useRef(0);
  const category = state.goods.shipmentCategory;
  // D176: with "Veicolo intero" the vehicle is chosen in the "Merce" step.
  const steps = useMemo(() => wizardSteps(STEPS, session).filter((s) => s.id !== "veicolo" || category !== "full_vehicle"), [session, category]);
  const stepIndex = useCallback((id: BookingStep) => steps.findIndex((s) => s.id === id), [steps]);

  // Restore after mount (localStorage is not available during server rendering).
  useEffect(() => {
    let restored: WizardState | null = null;
    try {
      restored = parseStoredState(window.localStorage.getItem(WIZARD_STORAGE_KEY));
    } catch {
      /* storage blocked: start empty */
    }
    const start = initialWizardStep(initialStep, session, "contatti");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from localStorage after hydration
    if (restored) setState(transportOnly(restored));
    if (restored && start && stepIndex(start as BookingStep) >= 0) {
      setStep(start as BookingStep);
      setMaxStep(stepIndex(start as BookingStep));
    }
    // A page kept alive by the router (sign-in and back) gets a new session: no stale "Accedi o registrati" error.
    setStepError(null);
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on mount, and again when the URL or the session changes
  }, [initialStep, session.kind]);

  useEffect(() => {
    if (!loaded || created) return;
    try {
      window.localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, loaded, created]);

  const update = useCallback((patch: Partial<WizardState>) => {
    setState((s) => ({ ...s, ...patch }));
    setStepError(null);
    if ("pickup" in patch || "delivery" in patch) setOutOfArea(false);
  }, []);

  // --- live quote ------------------------------------------------------------------------------------------
  // Same state + session within a minute → the same answer: "Avanti" reuses the live quote (quote-memo.ts).
  const [quoteMemo] = useState(() => createQuoteMemo<QuoteResponse>({ keep: keepQuoteResult }));
  const sessionKey = JSON.stringify(session);
  const quoteOf = useCallback(
    (s: WizardState, probe = false) => quoteMemo(`${probe ? "probe" : "quote"}|${sessionKey}|${JSON.stringify(s)}`, () => fetchQuote(s, probe)),
    [quoteMemo, sessionKey],
  );
  const runQuote = useCallback(async (s: WizardState) => {
    const seq = ++quoteSeq.current;
    setQuoting(true);
    const result = await quoteOf(s);
    if (seq !== quoteSeq.current) return result; // a newer request is on its way
    setQuote(result);
    setQuoting(false);
    return result;
  }, [quoteOf]);

  useEffect(() => {
    if (!loaded || !canQuote(state) || stepIndex(step) < stepIndex("data") || created) return;
    const t = setTimeout(() => void runQuote(state), 250);
    return () => clearTimeout(t);
  }, [state, step, loaded, runQuote, created, stepIndex]);

  // Step "Percorso": check the route as soon as both addresses are chosen, so "Avanti" usually has the answer already.
  useEffect(() => {
    if (!loaded || step !== "percorso" || !state.pickup || !state.delivery || created) return;
    const t = setTimeout(() => void quoteOf(state, true), 150);
    return () => clearTimeout(t);
  }, [state, step, loaded, quoteOf, created]);

  // Prefill billing data from the account (D36) when reaching "Riepilogo".
  useEffect(() => {
    if (step !== "riepilogo" || billingLoaded || session.kind !== "customer") return;
    void loadCheckoutDefaults().then((d) => {
      if (d) setBilling((b) => (Object.values(b).some(Boolean) ? b : { ...EMPTY_BILLING, ...d.billing }));
      setBillingLoaded(true);
    });
  }, [step, billingLoaded, session.kind]);

  const display = quote?.ok ? (quote.selected?.quote.display ?? (quote.customerType === "business" ? "net_plus_vat" : "gross")) : session.kind === "customer" ? (session.customerType === "business" ? "net_plus_vat" : "gross") : "net_plus_vat";
  const selected = quote?.ok ? quote.selected : null;
  const chosenVehicle = options.vehicles.find((v) => v.id === state.vehicleTypeId) ?? null;

  // --- navigation ------------------------------------------------------------------------------------------
  const go = (to: BookingStep) => {
    setStep(to);
    setMaxStep((m) => Math.max(m, stepIndex(to)));
    setStepError(null);
    setNotice(null);
    setOutOfArea(false);
    // Same step (e.g. an error sent back here): scroll now; otherwise after the new step has rendered.
    if (to === step) window.scrollTo({ top: 0, behavior: "instant" });
    else requestScrollTop();
  };

  /** Server check for the current step: errors that belong to this step or an earlier one block "Avanti". */
  async function blockingError(probe: boolean): Promise<string | null> {
    const result = probe ? await quoteOf(state, true) : await runQuote(state);
    setOutOfArea(!result.ok && isOutOfArea(result.error));
    if (result.ok) return null;
    if (stepIndex(result.step) <= stepIndex(step)) return result.message;
    return null;
  }

  async function vehicleError(): Promise<string | null> {
    const r = await runQuote(state);
    if (!state.vehicleTypeId) return "Scegli un veicolo.";
    if (!r.ok) return r.message;
    if (r.fit.byVehicle[state.vehicleTypeId]?.blocked.length) return r.fit.byVehicle[state.vehicleTypeId].blocked[0];
    if (!r.selected) return "Il veicolo scelto non è disponibile. Scegline un altro.";
    return null;
  }

  async function next() {
    setStepError(null);
    const i = stepIndex(step);
    const nextStep = steps[i + 1]?.id;
    let error: string | null = null;
    switch (step) {
      case "percorso":
        if (!state.pickup || !state.delivery) error = "Seleziona l'indirizzo di ritiro e quello di consegna dall'elenco.";
        else error = await blockingError(true);
        break;
      case "data":
        if (!state.pickupDate || !state.pickupWindow) error = "Scegli la data e la fascia oraria del ritiro.";
        else error = await blockingError(false);
        break;
      case "merce":
        error = goodsStepError(state.goods) ?? (category === "full_vehicle" ? await vehicleError() : await blockingError(false));
        break;
      case "veicolo":
        error = await vehicleError();
        break;
      case "preventivo":
        if (!selected) error = "Il preventivo non è ancora pronto.";
        break;
      case "account":
        error = accountStepError(session);
        break;
      case "contatti":
        if (!contacts.pickupName.trim() || !contacts.pickupPhone.trim() || !contacts.deliveryName.trim() || !contacts.deliveryPhone.trim()) {
          error = "Inserisci nome e telefono delle persone di riferimento al ritiro e alla consegna.";
        }
        break;
    }
    if (error) {
      setStepError(error);
      return;
    }
    if (nextStep) go(nextStep);
  }

  function confirm() {
    if (!selected) return;
    setFieldErrors({});
    setStepError(null);
    startSubmit(async () => {
      const result = await submitBooking({
        state,
        quoteId: selected.quoteId,
        shownTotalCents: selected.quote.totalCents,
        contacts,
        billing,
        acceptTerms,
      });
      switch (result.status) {
        case "created":
          try {
            window.localStorage.removeItem(WIZARD_STORAGE_KEY); // D78: cleared after the order
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
          setQuote((q) => (q?.ok ? { ...q, selected: { quoteId: result.quoteId, validUntil: result.validUntil, quote: result.quote } } : q));
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
          if (result.step && stepIndex(result.step) < stepIndex("riepilogo")) {
            go(result.step);
          }
          setStepError(result.message);
          break;
      }
    });
  }

  // --- render ----------------------------------------------------------------------------------------------
  if (!loaded) return <p className="py-10 text-center text-sm text-zinc-500">Caricamento…</p>;

  if (created) {
    return (
      <div className="mt-6 rounded-lg border border-green-200 bg-green-50 p-6">
        <h2 className="text-xl font-semibold text-green-900">Prenotazione registrata</h2>
        <p className="mt-2 text-green-900">
          Numero ordine: <strong>{created.number}</strong>
        </p>
        <p className="mt-2 text-sm text-green-900">Stato: In attesa di pagamento.</p>
        {created.paymentError ? <p className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">{created.paymentError}</p> : null}
        <Link href={`/cliente/ordini/${created.id}`} className="mt-4 inline-block rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700">Vai all&apos;ordine e paga</Link>
      </div>
    );
  }

  const minDate = romeToday();
  const helpText = (h: { persons: number; hours: number }) => `${h.persons === 1 ? "1 persona" : `${h.persons} persone`} × ${h.hours} h`;
  const fe = (k: string) => fieldErrors[k];

  const vehicleCards = () => (
    <>
              {quote?.ok && quote.fit.noneFits ? <p role="alert" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">{quote.fit.noneFits}</p> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                {options.vehicles.map((v) => {
                  const price = quote?.ok ? quote.vehicles.find((p) => p.vehicleTypeId === v.id) : undefined;
                  const check = quote?.ok ? quote.fit.byVehicle[v.id] : undefined;
                  const recommended = quote?.ok && quote.fit.recommended?.vehicleTypeId === v.id ? quote.fit.recommended : null;
                  const blocked = check?.blocked ?? [];
                  const unavailable = (price && "error" in price) || blocked.length > 0;
                  const chosen = state.vehicleTypeId === v.id;
                  const dims = v.lengthCm && v.widthCm && v.heightCm ? `${v.lengthCm} × ${v.widthCm} × ${v.heightCm} cm` : null;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      disabled={!!unavailable}
                      onClick={() => update({ vehicleTypeId: v.id })}
                      aria-pressed={chosen}
                      className={`relative overflow-hidden rounded-lg border text-left ${chosen ? "border-blue-600 bg-blue-50 ring-2 ring-blue-600" : recommended ? "border-green-600" : "border-zinc-300 hover:border-blue-400"} disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      {recommended ? <span className="absolute right-3 top-3 rounded-full bg-green-600 px-2 py-0.5 text-xs font-medium text-white">Consigliato</span> : null}
                      {/* Same drawings as the vehicle cards on the public pages (D183); the panel colour matches the wheel arches. */}
                      <span className="block bg-brand-50 px-6 pb-1 pt-4">
                        <VehicleIllustration sizeRank={v.sizeRank} className="mx-auto h-20 w-full max-w-52" />
                      </span>
                      <span className="block px-4 pb-4 pt-3">
                      <span className="block font-semibold text-zinc-900">{v.nameIt}</span>
                      <span className="mt-1 block text-xs text-zinc-600">
                        {[
                          v.payloadKg ? `Portata ${v.payloadKg.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")} kg` : null,
                          dims ? `Vano ${dims}` : null,
                          v.volumeDm3 ? `${(v.volumeDm3 / 1000).toLocaleString("it-IT")} m³` : null,
                          v.euroPallets != null ? (v.euroPallets === 0 ? "senza pallet" : `${v.euroPallets} pallet`) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {recommended ? <span className="mt-1 block text-xs text-green-800">{recommended.reason}</span> : null}
                      {blocked.map((b) => (
                        <span key={b} className="mt-1 block text-xs text-red-700">{b}</span>
                      ))}
                      {check?.warning && !blocked.length ? <span className="mt-1 block text-xs text-amber-800">{check.warning}</span> : null}
                      <span className="mt-2 block">
                        {price && "headlineCents" in price ? <Headline cents={price.headlineCents} display={display} /> : price && "error" in price ? <span className="text-sm text-zinc-500">Non disponibile</span> : <span className="text-sm text-zinc-400">{quoting ? "Calcolo…" : "—"}</span>}
                      </span>
                      </span>
                    </button>
                  );
                })}
              </div>
    </>
  );

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
          <h2 className="mb-4 text-lg font-semibold text-zinc-900">{steps[stepIndex(step)]?.label}</h2>

          {step === "percorso" ? (
            <div className="space-y-6">
              {(["pickup", "delivery"] as const).map((which) => {
                const value = state[which];
                const setPlace = (p: Pick<PlaceChoice, "placeId" | "label"> | null) =>
                  update({ [which]: p ? { floor: value?.floor ?? 0, hasElevator: value?.hasElevator ?? false, ...p } : null } as Partial<WizardState>);
                return (
                  <div key={which} className="space-y-3">
                    <AddressField id={`addr-${which}`} label={which === "pickup" ? "Indirizzo di ritiro" : "Indirizzo di consegna"} value={value} onChange={setPlace} />
                    {value ? (
                      <div className="flex flex-wrap items-end gap-4">
                        <div>
                          <label htmlFor={`floor-${which}`} className={label}>Piano</label>
                          <select id={`floor-${which}`} value={value.floor} onChange={(e) => update({ [which]: { ...value, floor: Number(e.target.value) } } as Partial<WizardState>)} className={`${input} w-32`}>
                            {Array.from({ length: 21 }, (_, n) => (
                              <option key={n} value={n}>{n === 0 ? "Piano terra" : `${n}° piano`}</option>
                            ))}
                          </select>
                        </div>
                        <label className="flex items-center gap-2 pb-2 text-sm">
                          <input type="checkbox" checked={value.hasElevator} onChange={(e) => update({ [which]: { ...value, hasElevator: e.target.checked } } as Partial<WizardState>)} />
                          Ascensore disponibile
                        </label>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {options.loadingHelpAvailable ? (
                <fieldset className="space-y-3 rounded-md border border-zinc-200 p-4">
                  <legend className="px-1 text-sm font-medium text-zinc-800">Aiuto per carico e scarico</legend>
                  {/* D182: loading and unloading help chosen separately, each with its own persons and hours */}
                  <LoadingHelpField
                    id="help-loading"
                    label="Aiuto al carico (al ritiro)"
                    value={state.loadingHelp}
                    onChange={(v) => update({ loadingHelp: v, portersPickup: null })}
                  />
                  <LoadingHelpField
                    id="help-unloading"
                    label="Aiuto allo scarico (alla consegna)"
                    value={state.unloadingHelp}
                    onChange={(v) => update({ unloadingHelp: v, portersPickup: null })}
                  />
                  <p className="text-xs text-zinc-500">Il prezzo è per persona e per ora di lavoro sul posto; il tempo di viaggio non conta.</p>
                </fieldset>
              ) : null}
              <p className="text-xs text-zinc-500">Il ritiro deve essere in una provincia servita; la consegna può essere ovunque in Italia entro {options.maxDistanceKm} km di percorso.</p>
            </div>
          ) : null}

          {step === "data" ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-4">
                <div>
                  <label htmlFor="pickup-date" className={label}>Data di ritiro <span className="text-red-600">*</span></label>
                  <input id="pickup-date" type="date" min={minDate} value={state.pickupDate ?? ""} onChange={(e) => update({ pickupDate: e.target.value || null })} className={`${input} w-48`} />
                </div>
                <div>
                  <label htmlFor="pickup-window" className={label}>Fascia oraria <span className="text-red-600">*</span></label>
                  <select id="pickup-window" value={state.pickupWindow ?? ""} onChange={(e) => update({ pickupWindow: (e.target.value || null) as TimeWindow | null })} className={`${input} w-48`}>
                    <option value="">Scegli…</option>
                    {TIME_WINDOWS.map((w) => (
                      <option key={w} value={w}>{TIME_WINDOW_LABEL[w]}</option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-xs text-zinc-500">
                Prenota almeno {options.minLeadHours} ore prima del ritiro. Se il ritiro è entro 24 ore, nel fine settimana o in un giorno festivo, il supplemento si applica automaticamente.
              </p>
            </div>
          ) : null}

          {step === "merce" ? (
            <div className="space-y-5">
              <fieldset>
                <legend className={label}>Cosa spedisci? <span className="text-red-600">*</span></legend>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {SHIPMENT_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      aria-pressed={category === o.id}
                      onClick={() => update({ goods: { ...state.goods, shipmentCategory: o.id } })}
                      className={`rounded-lg border p-3 text-left ${category === o.id ? "border-blue-600 bg-blue-50 ring-2 ring-blue-600" : "border-zinc-300 hover:border-blue-400"}`}
                    >
                      <span className="block text-sm font-semibold text-zinc-900">{o.label}</span>
                      <span className="mt-0.5 block text-xs text-zinc-600">{o.hint}</span>
                    </button>
                  ))}
                </div>
              </fieldset>

              {category === "pallet" || category === "gitterbox" || category === "package" || category === "document" ? (
                <div className="grid grid-cols-2 gap-4 sm:max-w-md">
                  <div>
                    <label htmlFor="goods-count" className={label}>
                      {category === "pallet" ? "Numero di pallet" : category === "gitterbox" ? "Numero di gitterbox" : category === "package" ? "Numero di colli" : "Numero di buste o plichi"}
                      {category === "document" ? null : <span className="text-red-600"> *</span>}
                    </label>
                    {category === "pallet" || category === "gitterbox" ? (
                      <input id="goods-count" inputMode="numeric" value={state.goods.palletsCount ?? ""} onChange={(e) => update({ goods: { ...state.goods, palletsCount: Math.min(100, intOrNull(e.target.value) ?? 0) || null } })} className={input} />
                    ) : (
                      <input id="goods-count" inputMode="numeric" value={state.goods.itemsCount ?? ""} onChange={(e) => update({ goods: { ...state.goods, itemsCount: intOrNull(e.target.value) } })} className={input} />
                    )}
                  </div>
                  {category !== "document" ? (
                    <div>
                      <label htmlFor="goods-weight" className={label}>Peso totale (kg)</label>
                      <input id="goods-weight" inputMode="numeric" value={state.goods.weightKg ?? ""} onChange={(e) => update({ goods: { ...state.goods, weightKg: intOrNull(e.target.value) } })} className={input} />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {category === "package" ? (
                <fieldset>
                  <legend className={label}>Collo più grande (cm)</legend>
                  <div className="mt-1 flex items-center gap-2">
                    {(["lengthCm", "widthCm", "heightCm"] as const).map((k, i) => (
                      <span key={k} className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
                        {i > 0 ? <span className="text-zinc-400">×</span> : null}
                        <input
                          id={`item-${k}`}
                          aria-label={{ lengthCm: "Lunghezza (cm)", widthCm: "Larghezza (cm)", heightCm: "Altezza (cm)" }[k]}
                          placeholder={{ lengthCm: "Lungh.", widthCm: "Largh.", heightCm: "Alt." }[k]}
                          inputMode="numeric"
                          value={state.goods.largestItem[k] ?? ""}
                          onChange={(e) => update({ goods: { ...state.goods, largestItem: { ...state.goods.largestItem, [k]: Math.min(2000, intOrNull(e.target.value) ?? 0) || null } } })}
                          className={`${input} mt-0 w-full min-w-0 sm:w-24`}
                        />
                      </span>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">Ci serve per consigliarti il veicolo giusto.</p>
                </fieldset>
              ) : null}

              {isStackableCategory(category) ? (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5" checked={state.goods.stackable} onChange={(e) => update({ goods: { ...state.goods, stackable: e.target.checked } })} />
                  <span>
                    Sovrapponibile
                    <span className="block text-xs text-zinc-500">La merce si può impilare durante il trasporto.</span>
                  </span>
                </label>
              ) : null}

              {category ? (
                <>
                  <div>
                    <label htmlFor="goods-description" className={label}>Descrizione della merce <span className="text-red-600">*</span></label>
                    <input id="goods-description" maxLength={2000} value={state.goods.description} onChange={(e) => update({ goods: { ...state.goods, description: e.target.value } })} className={input} placeholder={SHIPMENT_OPTIONS.find((o) => o.id === category)?.example} />
                  </div>
                  <div>
                    <label htmlFor="goods-dims" className={label}>Note sulla merce</label>
                    <input id="goods-dims" maxLength={500} value={state.goods.dimensionsNote} onChange={(e) => update({ goods: { ...state.goods, dimensionsNote: e.target.value } })} className={input} placeholder="Es. fragile, da tenere in piedi" />
                  </div>
                </>
              ) : null}

              {category === "full_vehicle" ? (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-zinc-800">Scegli il veicolo <span className="text-red-600">*</span></h3>
                  {vehicleCards()}
                </div>
              ) : null}
            </div>
          ) : null}

          {step === "veicolo" ? (
            <div className="space-y-3">
              {vehicleCards()}
              <p className="text-xs text-zinc-500">Il consiglio si basa su peso, oggetto più grande e pallet indicati; non considera la misura delle porte del vano.</p>
            </div>
          ) : null}

          {step === "preventivo" ? (
            <div className="space-y-4">
              {session.kind === "customer" ? null : (
                <p className="text-sm text-zinc-600">Prezzi IVA esclusa. Dopo l&apos;accesso vedrai il prezzo per il tuo account: ai privati IVA inclusa.</p>
              )}
              {selected ? (
                <>
                  <QuoteBreakdown quote={selected.quote} />
                  {selected.quote.porters.map((p) => {
                    const rate = p.overtimeRateNetCents == null ? null : selected.quote.display === "gross" ? formatCents(p.overtimeRateGrossCents ?? 0) : `${formatCents(p.overtimeRateNetCents)} + IVA`;
                    return (
                      <p key={`${p.legIndex}-${p.side}`} className="text-sm text-zinc-700">
                        {p.side === "loading" ? "Aiuto al carico" : p.side === "unloading" ? "Aiuto allo scarico" : "Aiuto per carico e scarico"} — nel prezzo {p.includedHours} h di lavoro
                        {rate ? `; ogni ora successiva iniziata ${rate} a persona.` : "."}
                      </p>
                    );
                  })}
                  <p className="text-xs text-zinc-500">Prezzo valido fino alle {new Date(selected.validUntil).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}. Dopo, lo ricalcoliamo prima della conferma.</p>
                </>
              ) : (
                <p className="text-sm text-zinc-500">{quoting ? "Calcolo del preventivo…" : "Completa i passaggi precedenti per vedere il preventivo."}</p>
              )}
            </div>
          ) : null}

          {step === "account" ? <AccountStep session={session} returnTo="/prenota?passo=account" /> : null}

          {step === "contatti" ? (
            <div className="space-y-4">
              {(["pickup", "delivery"] as const).map((w) => (
                <fieldset key={w} className="grid gap-4 sm:grid-cols-2">
                  <legend className="mb-2 text-sm font-medium text-zinc-800">{w === "pickup" ? "Persona di riferimento al ritiro" : "Persona di riferimento alla consegna"}</legend>
                  <div>
                    <label htmlFor={`${w}-name`} className={label}>Nome e cognome <span className="text-red-600">*</span></label>
                    <input id={`${w}-name`} autoComplete="name" maxLength={200} value={contacts[`${w}Name`]} onChange={(e) => setContacts({ ...contacts, [`${w}Name`]: e.target.value })} className={input} />
                    {fe(`contacts.${w}Name`) ? <p className="mt-1 text-sm text-red-600">{fe(`contacts.${w}Name`)}</p> : null}
                  </div>
                  <div>
                    <label htmlFor={`${w}-phone`} className={label}>Telefono <span className="text-red-600">*</span></label>
                    <input id={`${w}-phone`} type="tel" autoComplete="tel" value={contacts[`${w}Phone`]} onChange={(e) => setContacts({ ...contacts, [`${w}Phone`]: e.target.value })} className={input} />
                    {fe(`contacts.${w}Phone`) ? <p className="mt-1 text-sm text-red-600">{fe(`contacts.${w}Phone`)}</p> : null}
                  </div>
                </fieldset>
              ))}
              <div>
                <label htmlFor="notes" className={label}>Note per il trasportatore</label>
                <textarea id="notes" rows={3} maxLength={2000} value={contacts.notes} onChange={(e) => setContacts({ ...contacts, notes: e.target.value })} className={input} placeholder="Es. citofono, orari, accesso al cortile" />
              </div>
            </div>
          ) : null}

          {step === "riepilogo" ? (
            <div className="space-y-6">
              <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-zinc-500">Ritiro</dt>
                <dd>{state.pickup?.label} · {bookingDateLabel(state.pickupDate, { weekday: true })}, {state.pickupWindow ? TIME_WINDOW_LABEL[state.pickupWindow] : ""}</dd>
                <dt className="text-zinc-500">Consegna</dt>
                <dd>{state.delivery?.label}</dd>
                <dt className="text-zinc-500">Merce</dt>
                <dd>
                  {[SHIPMENT_OPTIONS.find((o) => o.id === category)?.label, state.goods.description, isStackableCategory(category) && state.goods.stackable ? "sovrapponibile" : null].filter(Boolean).join(" · ")}
                </dd>
                <dt className="text-zinc-500">Veicolo</dt>
                <dd className="flex items-center gap-2">
                  {chosenVehicle ? <VehicleIllustration sizeRank={chosenVehicle.sizeRank} className="h-8 w-16 shrink-0 rounded bg-brand-50" /> : null}
                  {chosenVehicle?.nameIt}
                </dd>
                {state.loadingHelp || state.unloadingHelp ? (
                  <>
                    <dt className="text-zinc-500">Aiuto</dt>
                    <dd>
                      {[
                        state.loadingHelp ? `carico: ${helpText(state.loadingHelp)}` : null,
                        state.unloadingHelp ? `scarico: ${helpText(state.unloadingHelp)}` : null,
                      ].filter(Boolean).join(" · ")}
                    </dd>
                  </>
                ) : null}
              </dl>

              {selected ? <QuoteBreakdown quote={selected.quote} /> : null}

              <BillingFields business={session.kind === "customer" && session.customerType === "business"} billing={billing} setBilling={setBilling} errors={fieldErrors} />
              <TermsCheckbox checked={acceptTerms} onChange={setAcceptTerms} error={fe("acceptTerms")} />
            </div>
          ) : null}

          {step === "riepilogo" ? <p className="mt-4 text-xs text-zinc-500">Dopo la conferma verrai indirizzato al pagamento sicuro con carta (Stripe).</p> : null}
          {notice ? <p role="status" className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">{notice}</p> : null}
          {stepError ? <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{stepError}</p> : null}
          {step === "percorso" && outOfArea && state.pickup && state.delivery ? (
            <section aria-labelledby="out-of-area-title" className="mt-4 rounded-md border border-zinc-200 p-4">
              <h3 id="out-of-area-title" className="font-semibold text-zinc-900">Lasciaci una richiesta</h3>
              <p className="mt-1 mb-4 text-sm text-zinc-600">Stiamo ampliando le zone servite. Scrivici: valutiamo il tuo trasporto e ti ricontattiamo.</p>
              <ContactForm
                key={`${state.pickup.placeId}|${state.delivery.placeId}`}
                action={sendOutOfAreaAction}
                idPrefix="out-of-area"
                hidden={{ pickupPlaceId: state.pickup.placeId, deliveryPlaceId: state.delivery.placeId }}
                messagePlaceholder="Cosa devi trasportare e quando?"
              />
            </section>
          ) : null}

          <div className="mt-6 flex justify-between gap-3">
            <button type="button" disabled={step === "percorso"} onClick={() => go(steps[stepIndex(step) - 1].id)} className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 disabled:invisible">
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
            <Headline cents={selected.quote.display === "gross" ? selected.quote.totalCents : selected.quote.subtotalCents} display={selected.quote.display} />
            {quoting ? <p className="text-xs text-zinc-400">Aggiornamento…</p> : null}
            {chosenVehicle ? (
              <div className="mt-3 overflow-hidden rounded-md bg-brand-50">
                <VehicleIllustration sizeRank={chosenVehicle.sizeRank} className="mx-auto h-24 w-full max-w-56 px-4 pt-3" />
                <p className="px-3 pb-2 text-center text-sm font-medium text-brand-900">{chosenVehicle.nameIt}</p>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">{quoting ? "Calcolo…" : "Il prezzo comparirà dopo la scelta del veicolo."}</p>
        )}
        {quote?.ok && quote.distancesKm.length ? <p className="mt-2 text-xs text-zinc-500">Percorso: {quote.distancesKm.map((k) => `${k} km`).join(" + ")}</p> : null}
      </aside>
    </div>
  );
}
