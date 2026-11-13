"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const available = publicAvailability(rates);
  const activeIndex = SERVICES.findIndex((s) => s.code === active);

  // Carousel-like switch: while sliding, all panels sit side by side in a track that moves from the old
  // panel to the new one and the box animates between their heights. At rest only the active panel is
  // shown, with no clipping (the address suggestions dropdown of Trasporto must not be cut off).
  const panels = useRef<(HTMLDivElement | null)[]>([]);
  const [slide, setSlide] = useState<Slide | null>(null);

  useLayoutEffect(() => {
    if (!slide || slide.phase !== "measure") return;
    const hFrom = panels.current[slide.from]?.offsetHeight ?? 0;
    const hTo = panels.current[slide.to]?.offsetHeight ?? 0;
    setSlide({ ...slide, hFrom, hTo, phase: "start" });
  }, [slide]);

  useEffect(() => {
    if (!slide || slide.phase === "measure") return;
    if (slide.phase === "start") {
      // Two frames: the browser must paint the start position before the transition begins.
      let id = requestAnimationFrame(() => {
        id = requestAnimationFrame(() => setSlide((cur) => (cur ? { ...cur, phase: "run" } : cur)));
      });
      return () => cancelAnimationFrame(id);
    }
    const t = setTimeout(() => setSlide(null), SLIDE_MS + 30);
    return () => clearTimeout(t);
  }, [slide]);

  function select(code: ServiceCode) {
    if (code === active) return;
    const to = SERVICES.findIndex((s) => s.code === code);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setSlide(reduce ? null : { from: activeIndex, to, hFrom: 0, hTo: 0, phase: "measure" });
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
    // min-w-0: the card is a grid item, so by default it may grow to its content's min-content width. While
    // sliding, all three panels sit side by side and their summed width would widen the card for a moment.
    <div id="calcola" className="min-w-0 scroll-mt-24 rounded-xl bg-white text-left shadow-xl ring-1 ring-black/5">
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
        className={slide ? "overflow-hidden" : undefined}
        style={
          slide && slide.phase !== "measure"
            ? {
                height: slide.phase === "run" ? slide.hTo : slide.hFrom,
                transition: slide.phase === "run" ? `height ${SLIDE_MS}ms ${EASE}` : undefined,
              }
            : undefined
        }
      >
        <div
          className="flex items-start"
          style={
            slide
              ? {
                  transform: `translateX(-${(slide.phase === "run" ? slide.to : slide.from) * 100}%)`,
                  transition: slide.phase === "run" ? `transform ${SLIDE_MS}ms ${EASE}` : undefined,
                }
              : undefined
          }
        >
          {SERVICES.map((s, i) => (
            <div
              key={s.code}
              ref={(el) => {
                panels.current[i] = el;
              }}
              id={`hero-panel-${s.code}`}
              role="tabpanel"
              aria-labelledby={`hero-tab-${s.code}`}
              hidden={!slide && active !== s.code}
              inert={active !== s.code}
              className="w-full shrink-0 p-5 sm:p-6"
            >
              {!available[s.code] && s.code !== "trasporto" ? (
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

const SLIDE_MS = 350;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

type Slide = { from: number; to: number; hFrom: number; hTo: number; phase: "measure" | "start" | "run" };

function Unavailable() {
  return (
    <p className="text-sm text-zinc-700">
      Al momento questo servizio non è prenotabile online.{" "}
      <Link href="/contatti" className="font-semibold text-brand-700 underline">Scrivici</Link> e ti aiutiamo noi.
    </p>
  );
}
