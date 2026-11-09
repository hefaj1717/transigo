"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * "Aggiorna" / "Riprova": re-renders the current server page (router.refresh). Disabled with a label while it
 * runs, so it cannot be pressed twice. `href` (optional) replaces the URL first — e.g. to drop ?avviso=.
 */
export function RefreshButton({ label, pendingLabel, className, href }: { label: string; pendingLabel: string; className: string; href?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      aria-busy={pending}
      onClick={() =>
        startTransition(() => {
          if (href) router.replace(href);
          router.refresh();
        })
      }
      className={className}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
