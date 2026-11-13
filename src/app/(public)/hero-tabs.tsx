"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PortersCalculator, StorageCalculator } from "@/components/site/calculators";
import { SERVICES, type ServiceCode } from "@/lib/public/content";
import { publicAvailability, type PublicRates } from "@/lib/public/rates";
import { HeroForm } from "@/components/site/hero-form";

/**
 * Home-page hero card with one tab per service (D151): Trasporto = the route form (→ /prenota),
 * Facchini and Deposito = indicative-price calculators (D162). Tabs follow the WAI-ARIA tabs pattern
 * (arrow keys move between tabs). `rates` = public customer rates only (null without an active price list).
 */
export function HeroTabs({ rates }: { rates: PublicRates | null }) {
  const [active, setActive] = useState<ServiceCode>("trasporto");
  const [direction, setDirection] = useState<"left" | "right" | null>(null);
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const available = publicAvailability(rates);
  const activeIndex = SERVICES.findIndex((s) => s.code === active);

  // Smooth height change between panels of different size: the outer box animates to the measured
  // height of the inner content (ResizeObserver also follows content changes inside a panel).
  const content = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  // Clip only while the height animates — otherwise the address suggestions dropdown would be cut off.
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Timer instead of `transitionend`: it also ends when the heights are equal or motion is reduced.
  useEffect(() => {
    if (!animating) return;
    const t = setTimeout(() => setAnimating(false), 320);
    return () => clearTimeout(t);
  }, [animating, active]);

  function select(code: ServiceCode) {
    if (code === active) return;
    const to = SERVICES.findIndex((s) => s.code === code);
    setDirection(to > activeIndex ? "right" : "left");
    setAnimating(true);
    setActive(code);
  }

  function onKey(e: React.KeyboardEvent, index: number) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = SERVICES[(index + delta + SERVICES.length) % SERVICES.length].code;
    select(next);
    tabs.current[next]?.focus();
  }

  return (
    <div id="calcola" className="scroll-mt-24 rounded-xl bg-white text-left shadow-xl ring-1 ring-black/5">
      <div role="tablist" aria-label="Servizio" className="relative grid grid-cols-3 border-b border-zinc-200">
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
            onClick={() => select(s.code)}
            onKeyDown={(e) => onKey(e, i)}
            className={`px-2 py-3.5 text-sm font-semibold transition-colors duration-200 sm:text-base ${active === s.code ? "text-brand-900" : "text-zinc-500 hover:text-brand-800"}`}
          >
            {s.tab}
          </button>
        ))}
        {/* Underline of the active tab: one bar sliding between the tabs. */}
        <span
          aria-hidden
          className="absolute -bottom-px left-0 h-0.5 w-1/3 bg-accent-600 motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out"
          style={{ transform: `translateX(${activeIndex * 100}%)` }}
        />
      </div>
      <div
        className={`motion-safe:transition-[height] motion-safe:duration-300 motion-safe:ease-out ${animating ? "overflow-hidden" : ""}`}
        style={height === null || !animating ? undefined : { height }}
      >
      <div ref={content}>
      {SERVICES.map((s) => (
        <div key={s.code} id={`hero-panel-${s.code}`} role="tabpanel" aria-labelledby={`hero-tab-${s.code}`} hidden={active !== s.code} className={`p-5 sm:p-6 ${direction === "right" ? "motion-safe:animate-tab-in-right" : direction === "left" ? "motion-safe:animate-tab-in-left" : ""}`}>
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
      </div>
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
