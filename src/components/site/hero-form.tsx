"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AddressField } from "@/components/address-field";
import { heroToWizardState, type HeroInput } from "@/lib/booking/hero";
import { parseStoredState, WIZARD_STORAGE_KEY } from "@/lib/booking/state";
import { romeToday } from "@/lib/booking/windows";

type Place = HeroInput["pickup"];

/**
 * Home-page mini form (Da / A / Data). Prepares the wizard state in localStorage (D78: route and date only)
 * and opens /prenota on its first step, where the customer adds floors and continues. No price here (D76).
 * `embedded`: inside the home-page tabs (HeroTabs), without its own card.
 */
export function HeroForm({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const [pickup, setPickup] = useState<Place>(null);
  const [delivery, setDelivery] = useState<Place>(null);
  const [date, setDate] = useState("");
  const [errors, setErrors] = useState<Partial<Record<"pickup" | "delivery" | "date" | "form", string>>>({});
  const [busy, setBusy] = useState(false);
  // Today's date only after mount: the page is prerendered, so no clock read during render.
  const [today, setToday] = useState<string | undefined>(undefined);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- client clock read once after hydration
  useEffect(() => setToday(romeToday()), []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    let previous = null;
    try {
      previous = parseStoredState(window.localStorage.getItem(WIZARD_STORAGE_KEY));
    } catch {
      /* storage blocked */
    }
    const result = heroToWizardState({ pickup, delivery, date }, romeToday(), previous);
    if (!result.ok) {
      setErrors({ [result.field]: result.message });
      return;
    }
    try {
      window.localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(result.state));
    } catch {
      setErrors({ form: "Il browser non consente di salvare i dati. Inserisci gli indirizzi direttamente nella prenotazione." });
      return;
    }
    setBusy(true);
    router.push("/prenota");
  }

  return (
    <form onSubmit={submit} noValidate className={embedded ? "text-left" : "rounded-xl bg-white p-5 text-left shadow-xl ring-1 ring-black/5 sm:p-6"}>
      {embedded ? null : <h2 className="text-lg font-semibold text-brand-900">Calcola il prezzo</h2>}
      <p className={embedded ? "text-sm text-zinc-600" : "mt-1 text-sm text-zinc-600"}>Prezzo esatto subito, gratis e senza registrazione.</p>
      <div className="mt-4 space-y-4">
        <AddressField id="hero-pickup" label="Da (ritiro)" value={pickup} onChange={(p) => { setPickup(p); setErrors({}); }} externalError={errors.pickup} />
        <AddressField id="hero-delivery" label="A (consegna)" value={delivery} onChange={(p) => { setDelivery(p); setErrors({}); }} externalError={errors.delivery} />
        <div>
          <label htmlFor="hero-date" className="block text-sm font-medium text-zinc-800">Data del ritiro</label>
          <input
            id="hero-date"
            type="date"
            min={today}
            value={date}
            onChange={(e) => { setDate(e.target.value); setErrors({}); }}
            aria-invalid={errors.date ? true : undefined}
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-brand-500"
          />
          {errors.date ? <p className="mt-1 text-sm text-red-600">{errors.date}</p> : null}
        </div>
      </div>
      {errors.form ? <p className="mt-3 text-sm text-red-600">{errors.form}</p> : null}
      <button
        type="submit"
        disabled={busy}
        className="mt-5 w-full rounded-md bg-accent-600 px-4 py-3 text-base font-semibold text-white hover:bg-accent-700 disabled:opacity-60"
      >
        {busy ? "Un momento…" : "Calcola il prezzo"}
      </button>
    </form>
  );
}
