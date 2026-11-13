"use client";

import { useState, type ReactNode } from "react";

/**
 * Step content of a booking wizard: on a step change the new step slides in — from the right when moving
 * forward ("Avanti"), from the left when going back ("Indietro" or a click on an earlier step). The first render
 * is not animated. Animations live in globals.css and are skipped with "reduce motion".
 */
export function StepTransition({ step, index, children }: { step: string; index: number; children: ReactNode }) {
  const [shown, setShown] = useState({ step, index });
  const [direction, setDirection] = useState<"forward" | "back" | null>(null);
  if (shown.step !== step) {
    setDirection(index >= shown.index ? "forward" : "back");
    setShown({ step, index });
  }
  const cls = direction === "forward" ? "motion-safe:animate-step-from-right" : direction === "back" ? "motion-safe:animate-step-from-left" : undefined;
  return (
    <div key={step} className={cls}>
      {children}
    </div>
  );
}
