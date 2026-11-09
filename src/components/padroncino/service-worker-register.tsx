"use client";

import { useEffect } from "react";

// Registers the carrier service worker (public/padroncino/sw.js, scope /padroncino — D104).
// Production builds only: in `next dev` cached /_next/static chunks would go stale between edits.
// To test locally: npm run build && npm start.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/padroncino/sw.js", { scope: "/padroncino", updateViaCache: "none" })
      .catch((err: unknown) => console.warn("[pwa] service worker registration failed", err));
  }, []);
  return null;
}
