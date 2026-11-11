"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { bigButton, bigButtonSecondary } from "../carrier-shell";

/**
 * In-app confirmation (bottom sheet on phones) for irreversible steps — never window.confirm()/alert().
 * The confirm button gets the focus; Escape or a tap outside cancels (not while sending).
 */
export function ConfirmSheet({
  open,
  title,
  children,
  confirmLabel,
  pendingLabel,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending, onCancel]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => !pending && onCancel()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-xl sm:rounded-3xl"
      >
        <h2 id={titleId} className="text-xl font-semibold text-zinc-900">{title}</h2>
        {children ? <div className="mt-3 text-sm text-zinc-700">{children}</div> : null}
        <div className="mt-5 space-y-3">
          <button ref={confirmRef} type="button" onClick={onConfirm} disabled={pending} aria-busy={pending} className={bigButton}>
            {pending ? pendingLabel : confirmLabel}
          </button>
          <button type="button" onClick={onCancel} disabled={pending} className={bigButtonSecondary}>
            Annulla
          </button>
        </div>
      </div>
    </div>
  );
}
