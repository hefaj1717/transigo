"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Scroll the page to the top after the wizard has rendered the new step.
 *
 * Scrolling inside the click handler (before React commits) does not work on phones: a smooth scroll starts on the
 * old, long step (e.g. "Merce" with the vehicle cards), the page then shrinks to the new step and the browser cancels
 * the animation and clamps the position — the customer lands at the bottom of the page. Here the scroll runs after
 * the commit and is instant (overrides `scroll-smooth` on <html>).
 *
 * Returns `requestScrollTop()` to call together with `setStep()`; the first render never scrolls.
 */
export function useScrollTopOnStep(step: string): () => void {
  const pending = useRef(false);
  useLayoutEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [step]);
  return useCallback(() => {
    pending.current = true;
  }, []);
}
