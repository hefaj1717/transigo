"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { PortersCalculator, StorageCalculator } from "@/components/site/calculators";
import { SERVICES, type ServiceCode } from "@/lib/public/content";
import { publicAvailability, type PublicRates } from "@/lib/public/rates";
import { HeroForm } from "./hero-form";

/**
 * Home-page hero card with one tab per service (D151): Trasporto = the route form (→ /prenota),
 * Facchini and Deposito = indicative-price calculators (D162). Tabs follow the WAI-ARIA tabs pattern
 * (arrow keys move between tabs). `rates` = public customer rates only (null without an active price list).
 */
export function HeroTabs({ rates }: { rates: PublicRates | null }) {
  const [active, setActive] = useState<ServiceCode>("trasporto");
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const available = publicAvailability(rates);

  function onKey(e: React.KeyboardEvent, index: number) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = SERVICES[(index + delta + SERVICES.length) % SERVICES.length].code;
    setActive(next);
    tabs.current[next]?.focus();
  }

  return (
    <div className="rounded-xl bg-white text-left shadow-xl ring-1 ring-black/5">
      <div role="tablist" aria-label="Servizio" className="grid grid-cols-3 border-b border-zinc-200">
        {SERVICES.map((s, i) => (
          <button
            key={s.code}
            ref={(el) => {
              tabs.current[s.code] = el;
            }}
            id={`hero-tab-${s.code}`}
            role="tab"
            type="button"
            aria-selected={active === s.code}
            aria-controls={`hero-panel-${s.code}`}
            tabIndex={active === s.code ? 0 : -1}
            onClick={() => setActive(s.code)}
            onKeyDown={(e) => onKey(e, i)}
            className={`-mb-px border-b-2 px-2 py-3.5 text-sm font-semibold sm:text-base ${active === s.code ? "border-accent-600 text-brand-900" : "border-transparent text-zinc-500 hover:text-brand-800"}`}
          >
            {s.tab}
          </button>
        ))}
      </div>
      {SERVICES.map((s) => (
        <div key={s.code} id={`hero-panel-${s.code}`} role="tabpanel" aria-labelledby={`hero-tab-${s.code}`} hidden={active !== s.code} className="p-5 sm:p-6">
          {active !== s.code ? null : !available[s.code] && s.code !== "trasporto" ? (
            <Unavailable />
          ) : s.code === "trasporto" ? (
            <HeroForm embedded />
          ) : s.code === "facchinaggio" ? (
            <PortersCalculator rates={rates!} />
          ) : (
            <StorageCalculator rates={rates!} />
          )}
        </div>
      ))}
    </div>
  );
}

function Unavailable() {
  return (
    <p className="text-sm text-zinc-700">
      Al momento questo servizio non è prenotabile online.{" "}
      <Link href="/contatti" className="font-semibold text-brand-700 underline">Scrivici</Link> e ti aiutiamo noi.
    </p>
  );
}
