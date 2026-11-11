"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { AccountStep } from "@/components/booking/account-step";
import { BillingFields, EMPTY_BILLING, TermsCheckbox, type Billing } from "@/components/booking/billing-fields";
import { AddressField } from "@/components/address-field";
import { isPortersOutOfArea, type PortersError, type PortersStep, type PublicPortersJob } from "@/lib/booking/porters/messages";
import type { PortersOptions } from "@/lib/booking/porters/server";
import {
  EMPTY_PORTERS_STATE,
  parseStoredPortersState,
  PORTERS_STORAGE_KEY,
  PORTERS_WIZARD_PATH,
  type PortersPrefill,
  type PortersState,
} from "@/lib/booking/porters/state";
import type { PublicQuote } from "@/lib/booking/public-quote";
import { accountStepError, type WizardSession } from "@/lib/booking/session";
import { romeToday, TIME_WINDOW_LABEL, TIME_WINDOWS, type TimeWindow } from "@/lib/booking/windows";
import { formatCents } from "@/lib/pricing/money";
import { PORTERS_MAX_HOURS, PORTERS_MAX_PERSONS } from "@/lib/pricing/porters-service";
import { portersContactHref } from "@/lib/public/requests";
import { loadCheckoutDefaults } from "../actions";
import { Headline, QuoteBreakdown } from "../quote-view";
import { submitPortersBooking } from "./actions";

// Facchinaggio wizard (D158). Same model as the transport wizard: the state (no personal data) is kept in
// localStorage (D78); contacts and billing only in memory; every price comes from the server (D76).

const input = "mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-blue-500";
const label = "block text-sm font-medium text-zinc-800";

const STEPS: { id: PortersStep; label: string }[] = [
  { id: "indirizzo", label: "Indirizzo" },
  { id: "data", label: "Data e fascia" },
  { id: "facchini", label: "Facchini" },
  { id: "ore", label: "Ore stimate" },
  { id: "piano", label: "Piano e ascensore" },
  { id: "cosa", label: "Cosa spostare" },
  { id: "preventivo", label: "Preventivo" },
  { id: "account", label: "Account" },
  { id: "contatti", label: "Contatti" },
  { id: "riepilogo", label: "Riepilogo" },
];
const stepIndex = (id: PortersStep) => STEPS.findIndex((s) => s.id === id);
const isStep = (s: string | null): s is PortersStep => !!s && STEPS.some((x) => x.id === s);

type QuoteResponse =
  | { ok: true; customerType: "private" | "business"; quoteId: string; validUntil: string; quote: PublicQuote; job: PublicPortersJob; city: string }
  | { ok: false; customerType?: "private" | "business"; error: PortersError; message: string; step: PortersStep };

type Contacts = { siteName: string; sitePhone: string; notes: string };
const EMPTY_CONTACTS: Contacts = { siteName: "", sitePhone: "", notes: "" };

async function fetchQuote(state: PortersState, probe = false): Promise<QuoteResponse> {
  try {
    const res = await fetch("/api/booking/porters-quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, probe }) });
    return (await res.json()) as QuoteResponse;
  } catch {
    return { ok: false, error: { code: "pricing_unavailable" }, message: "Connessione non disponibile. Riprova.", step: "preventivo" };
  }
}

const canQuote = (s: PortersState) => !!(s.place && s.date && s.window);
const floorLabel = (n: number) => (n === 0 ? "Piano terra" : `${n}° piano`);

export function PortersWizard({ options, session, initialStep, prefill }: { options: NonNullable<PortersOptions>; session: WizardSession; initialStep: string | null; prefill: PortersPrefill }) {
  const [state, setState] = useState<PortersState>(EMPTY_PORTERS_STATE);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<PortersStep>("indirizzo");
  const [maxStep, setMaxStep] = useState(0);
  const [contacts, setContacts] = useState<Contacts>(EMPTY_CONTACTS);
  const [billing, setBilling] = useState<Billing>(EMPTY_BILLING);
  const [billingLoaded, setBillingLoaded] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [outOfArea, setOutOfArea] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; number: string; paymentError: string | null } | null>(null);
  const [submitting, startSubmit] = useTransition();
  const quoteSeq = useRef(0);
  const prefillPlace = useRef({ floor: prefill.floor, hasElevator: prefill.hasElevator });

  // Restore after mount; values from the calculator link win over the stored team and hours (D162).
  useEffect(() => {
    let restored: PortersState | null = null;
    try {
      restored = parseStoredPortersState(window.localStorage.getItem(PORTERS_STORAGE_KEY));
    } catch {
      /* storage blocked: start empty */
    }
    const base = restored ?? EMPTY_PORTERS_STATE;
    const persons = Math.max(prefill.persons ?? base.persons, options.minPersons);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from localStorage after hydration
    setState({ ...base, persons, hours: prefill.hours ?? base.hours });
    if (restored && isStep(initialStep)) {
      setStep(initialStep);
      setMaxStep(stepIndex(initialStep));
    }
    setLoaded(true);
  }, [initialStep, prefill.persons, prefill.hours, options.minPersons]);

  useEffect(() => {
    if (!loaded || created) return;
    try {
      window.localStorage.setItem(PORTERS_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, loaded, created]);

  const update = useCallback((patch: Partial<PortersState>) => {
    setState((s) => ({ ...s, ...patch }));
    setStepError(null);
    if ("place" in patch) setOutOfArea(false);
  }, []);

  const runQuote = useCallback(async (s: PortersState) => {
    const seq = ++quoteSeq.current;
    setQuoting(true);
    const result = await fetchQuote(s);
    if (seq !== quoteSeq.current) return result;
    setQuote(result);
    setQuoting(false);
    return result;
  }, []);

  useEffect(() => {
    if (!loaded || !canQuote(state) || stepIndex(step) < stepIndex("data") || created) return;
    const t = setTimeout(() => void runQuote(state), 500);
    return () => clearTimeout(t);
  }, [state, step, loaded, runQuote, created]);

  useEffect(() => {
    if (step !== "riepilogo" || billingLoaded || session.kind !== "customer") return;
    void loadCheckoutDefaults().then((d) => {
      if (d) setBilling((b) => (Object.values(b).some(Boolean) ? b : { ...EMPTY_BILLING, ...d.billing }));
      setBillingLoaded(true);
    });
  }, [step, billingLoaded, session.kind]);

  const selected = quote?.ok ? quote : null;
  const display = selected?.quote.display ?? (session.kind === "customer" ? (session.customerType === "business" ? "net_plus_vat" : "gross") : state.customerTypeView === "business" ? "net_plus_vat" : "gross");

  const go = (to: PortersStep) => {
    setStep(to);
    setMaxStep((m) => Math.max(m, stepIndex(to)));
    setStepError(null);
    setNotice(null);
    setOutOfArea(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** Server check: errors of this step or an earlier one block "Avanti". */
  async function blockingError(probe: boolean): Promise<string | null> {
    const result = probe ? await fetchQuote(state, true) : await runQuote(state);
    setOutOfArea(!result.ok && isPortersOutOfArea(result.error));
    if (result.ok) return null;
    return stepIndex(result.step) <= stepIndex(step) ? result.message : null;
  }

  async function next() {
    setStepError(null);
    let error: string | null = null;
    switch (step) {
      case "indirizzo":
        error = state.place ? await blockingError(true) : "Seleziona l'indirizzo dall'elenco.";
        break;
      case "data":
        error = state.date && state.window ? await blockingError(false) : "Scegli la data e la fascia oraria.";
        break;
      case "facchini":
      case "ore":
      case "piano":
        error = await blockingError(false);
        break;
      case "cosa":
        error = state.description.trim() ? await blockingError(false) : "Descrivi cosa c'è da spostare.";
        break;
      case "preventivo":
        if (!selected) error = quoting ? "Il preventivo non è ancora pronto." : (quote && !quote.ok ? quote.message : "Il preventivo non è ancora pronto.");
        break;
      case "account":
        error = accountStepError(session);
        break;
      case "contatti":
        if (!contacts.siteName.trim() || !contacts.sitePhone.trim()) error = "Inserisci nome e telefono della persona presente sul posto.";
        break;
    }
    if (error) {
      setStepError(error);
      return;
    }
    const nextStep = STEPS[stepIndex(step) + 1]?.id;
    if (nextStep) go(nextStep);
  }

  function confirm() {
    if (!selected) return;
    setFieldErrors({});
    setStepError(null);
    startSubmit(async () => {
      const result = await submitPortersBooking({ state, quoteId: selected.quoteId, shownTotalCents: selected.quote.totalCents, contacts, billing, acceptTerms });
      switch (result.status) {
        case "created":
          try {
            window.localStorage.removeItem(PORTERS_STORAGE_KEY); // D78
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
          setQuote((q) => ({ ok: true, customerType: q?.customerType ?? "private", quoteId: result.quoteId, validUntil: result.validUntil, quote: result.quote, job: result.job, city: q?.ok ? q.city : "" }));
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
  const place = state.place;
  const overtime = selected?.job.overtimeRateNetCents == null ? null : display === "gross" ? formatCents(selected.job.overtimeRateGrossCents ?? 0) : `${formatCents(selected.job.overtimeRateNetCents)} + IVA`;
  const personsOptions = Array.from({ length: PORTERS_MAX_PERSONS - options.minPersons + 1 }, (_, i) => options.minPersons + i);

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div>
        <ol className="mb-6 flex flex-wrap gap-2 text-xs" aria-label="Passaggi">
          {STEPS.map((s, i) => (
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
          <h2 className="mb-4 text-lg font-semibold text-zinc-900">{STEPS[stepIndex(step)].label}</h2>

          {step === "indirizzo" ? (
            <div className="space-y-3">
              <AddressField
                id="addr-porters"
                label="Indirizzo del lavoro"
                value={place}
                onChange={(p) =>
                  update({
                    place: p
                      ? { floor: place?.floor ?? prefillPlace.current.floor ?? 0, hasElevator: place?.hasElevator ?? prefillPlace.current.hasElevator ?? false, ...p }
                      : null,
                  })
                }
              />
              <p className="text-xs text-zinc-500">Il facchinaggio è disponibile nelle province servite. Il trasporto non è incluso: per spostare la merce in un altro indirizzo prenota un trasporto.</p>
            </div>
          ) : null}

          {step === "data" ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-4">
                <div>
                  <label htmlFor="porters-date" className={label}>Data <span className="text-red-600">*</span></label>
                  <input id="porters-date" type="date" min={romeToday()} value={state.date ?? ""} onChange={(e) => update({ date: e.target.value || null })} className={`${input} w-48`} />
                </div>
                <div>
                  <label htmlFor="porters-window" className={label}>Fascia di arrivo <span className="text-red-600">*</span></label>
                  <select id="porters-window" value={state.window ?? ""} onChange={(e) => update({ window: (e.target.value || null) as TimeWindow | null })} className={`${input} w-48`}>
                    <option value="">Scegli…</option>
                    {TIME_WINDOWS.map((w) => (
                      <option key={w} value={w}>{TIME_WINDOW_LABEL[w]}</option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-xs text-zinc-500">
                Prenota almeno {options.minLeadHours} ore prima. I supplementi per lavori urgenti, nel fine settimana o nei giorni festivi vengono calcolati automaticamente.
              </p>
            </div>
          ) : null}

          {step === "facchini" ? (
            <fieldset>
              <legend className={label}>Quanti facchini ti servono?</legend>
              <div className="mt-2 flex flex-wrap gap-3">
                {personsOptions.map((n) => (
                  <label key={n} className={`flex cursor-pointer items-center gap-2 rounded-md border px-4 py-2 text-sm ${state.persons === n ? "border-blue-600 bg-blue-50" : "border-zinc-300"}`}>
                    <input type="radio" name="persons" checked={state.persons === n} onChange={() => update({ persons: n })} />
                    {n} facchini
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-zinc-500">Minimo {options.minPersons} facchini. Per mobili pesanti o tanti piani a piedi conviene una squadra più grande.</p>
            </fieldset>
          ) : null}

          {step === "ore" ? (
            <div>
              <label htmlFor="porters-hours" className={label}>Ore stimate di lavoro</label>
              <select id="porters-hours" value={state.hours} onChange={(e) => update({ hours: Number(e.target.value) })} className={`${input} w-40`}>
                {Array.from({ length: PORTERS_MAX_HOURS }, (_, i) => i + 1).map((h) => (
                  <option key={h} value={h}>{h} {h === 1 ? "ora" : "ore"}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-zinc-500">
                Minimo {options.minHours} {options.minHours === 1 ? "ora" : "ore"} per facchino{state.hours < options.minHours ? `: verranno conteggiate ${options.minHours} ore` : ""}. Le ore in più vengono calcolate a fine lavoro.
              </p>
            </div>
          ) : null}

          {step === "piano" ? (
            place ? (
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <label htmlFor="porters-floor" className={label}>Piano</label>
                  <select id="porters-floor" value={place.floor} onChange={(e) => update({ place: { ...place, floor: Number(e.target.value) } })} className={`${input} w-36`}>
                    {Array.from({ length: 21 }, (_, n) => (
                      <option key={n} value={n}>{floorLabel(n)}</option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input type="checkbox" checked={place.hasElevator} onChange={(e) => update({ place: { ...place, hasElevator: e.target.checked } })} />
                  Ascensore disponibile
                </label>
              </div>
            ) : (
              <p className="text-sm text-zinc-500">Scegli prima l&apos;indirizzo.</p>
            )
          ) : null}

          {step === "cosa" ? (
            <div>
              <label htmlFor="porters-what" className={label}>Cosa c&apos;è da spostare? <span className="text-red-600">*</span></label>
              <textarea id="porters-what" rows={4} maxLength={2000} value={state.description} onChange={(e) => update({ description: e.target.value })} className={input} placeholder="Es. salita di un divano al 3° piano, scarico di 20 scatoloni dal furgone, spostamento di mobili tra due stanze" />
            </div>
          ) : null}

          {step === "preventivo" ? (
            <div className="space-y-4">
              {session.kind === "customer" ? null : (
                <fieldset>
                  <legend className="text-sm text-zinc-700">Mostra i prezzi per</legend>
                  <div className="mt-1 flex gap-4">
                    {(["private", "business"] as const).map((t) => (
                      <label key={t} className="flex items-center gap-2 text-sm">
                        <input type="radio" name="customerTypeView" checked={state.customerTypeView === t} onChange={() => update({ customerTypeView: t })} />
                        {t === "private" ? "Privato (IVA inclusa)" : "Azienda (IVA esclusa)"}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              {selected ? (
                <>
                  <QuoteBreakdown quote={selected.quote} />
                  <p className="text-sm text-zinc-700">
                    Nel prezzo {selected.job.persons} facchini per {selected.job.includedHours} {selected.job.includedHours === 1 ? "ora" : "ore"} di lavoro
                    {overtime ? `; ogni ora successiva iniziata ${overtime} a persona (tolleranza ${selected.job.overtimeGraceMinutes} minuti).` : "."}
                  </p>
                  <p className="text-xs text-zinc-500">Prezzo valido fino alle {new Date(selected.validUntil).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}. Dopo, lo ricalcoliamo prima della conferma.</p>
                </>
              ) : (
                <p className="text-sm text-zinc-500">{quoting ? "Calcolo del preventivo…" : quote && !quote.ok ? quote.message : "Completa i passaggi precedenti per vedere il preventivo."}</p>
              )}
            </div>
          ) : null}

          {step === "account" ? <AccountStep session={session} returnTo={`${PORTERS_WIZARD_PATH}?passo=account`} /> : null}

          {step === "contatti" ? (
            <div className="space-y-4">
              <fieldset className="grid gap-4 sm:grid-cols-2">
                <legend className="mb-2 text-sm font-medium text-zinc-800">Persona presente sul posto</legend>
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
              <div>
                <label htmlFor="porters-notes" className={label}>Note per i facchini</label>
                <textarea id="porters-notes" rows={3} maxLength={2000} value={contacts.notes} onChange={(e) => setContacts({ ...contacts, notes: e.target.value })} className={input} placeholder="Es. citofono, parcheggio, accesso al cortile" />
              </div>
            </div>
          ) : null}

          {step === "riepilogo" ? (
            <div className="space-y-6">
              <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-zinc-500">Indirizzo</dt>
                <dd>{place?.label} · {place ? floorLabel(place.floor) : ""}{place && place.floor > 0 ? (place.hasElevator ? ", con ascensore" : ", senza ascensore") : ""}</dd>
                <dt className="text-zinc-500">Quando</dt>
                <dd>{state.date} {state.window ? TIME_WINDOW_LABEL[state.window] : ""}</dd>
                <dt className="text-zinc-500">Squadra</dt>
                <dd>{state.persons} facchini, {selected?.job.includedHours ?? state.hours} ore</dd>
                <dt className="text-zinc-500">Cosa spostare</dt>
                <dd className="whitespace-pre-line">{state.description}</dd>
              </dl>
              {selected ? <QuoteBreakdown quote={selected.quote} /> : null}
              <BillingFields business={session.kind === "customer" && session.customerType === "business"} billing={billing} setBilling={setBilling} errors={fieldErrors} />
              <TermsCheckbox checked={acceptTerms} onChange={setAcceptTerms} error={fe("acceptTerms")} />
              <p className="text-xs text-zinc-500">Dopo la conferma verrai indirizzato al pagamento sicuro con carta (Stripe).</p>
            </div>
          ) : null}

          {notice ? <p role="status" className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">{notice}</p> : null}
          {stepError ? <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{stepError}</p> : null}
          {outOfArea ? (
            <p className="mt-4 rounded-md border border-zinc-200 p-4 text-sm text-zinc-700">
              Stiamo ampliando le zone servite.{" "}
              <Link className="text-blue-700 underline" href={portersContactHref({ persons: state.persons, hours: state.hours, floor: place?.floor ?? 0, hasElevator: place?.hasElevator ?? false })}>
                Lasciaci una richiesta
              </Link>
              : ti ricontattiamo noi.
            </p>
          ) : null}

          <div className="mt-6 flex justify-between gap-3">
            <button type="button" disabled={step === "indirizzo"} onClick={() => go(STEPS[stepIndex(step) - 1].id)} className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 disabled:invisible">
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
            <p className="mt-1 text-xs text-zinc-500">{selected.job.persons} facchini · {selected.job.includedHours} ore · {selected.city}</p>
            {quoting ? <p className="text-xs text-zinc-400">Aggiornamento…</p> : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">{quoting ? "Calcolo…" : "Il prezzo comparirà dopo la scelta della data."}</p>
        )}
      </aside>
    </div>
  );
}
