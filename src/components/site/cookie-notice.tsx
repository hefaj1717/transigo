"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { COOKIE_NOTICE_STORAGE_KEY } from "@/lib/public/cookies";

/**
 * Informative cookie notice (D125, D126): the site uses technical storage only, so there is nothing to
 * accept or refuse — "Ok" just hides the notice. Rendered only after mount (localStorage is not available
 * on the server); storage blocked → the notice shows on every visit, nothing breaks.
 */
export function CookieNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(COOKIE_NOTICE_STORAGE_KEY) === "1";
    } catch {
      /* storage blocked */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after hydration
    if (!dismissed) setVisible(true);
  }, []);

  if (!visible) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(COOKIE_NOTICE_STORAGE_KEY, "1");
    } catch {
      /* storage blocked: hide for this page view only */
    }
    setVisible(false);
  }

  return (
    <div role="region" aria-label="Informativa sui cookie" className="fixed inset-x-0 bottom-0 z-40 p-3 sm:p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-xl bg-brand-950 p-4 text-sm text-brand-50 shadow-2xl sm:flex-row sm:items-center sm:gap-6">
        <p className="flex-1">
          Usiamo solo cookie tecnici, necessari al funzionamento del sito (ad esempio per mantenere l&apos;accesso). Nessun cookie di profilazione.{" "}
          <Link href="/cookie" className="font-medium text-accent-300 underline hover:text-accent-200">Cookie policy</Link>
        </p>
        <button type="button" onClick={dismiss} className="shrink-0 rounded-md bg-accent-500 px-5 py-2 font-semibold text-white hover:bg-accent-600">
          Ok
        </button>
      </div>
    </div>
  );
}
