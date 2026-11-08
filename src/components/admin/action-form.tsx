"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { initialActionResult, type ActionResult } from "@/lib/admin/action-result";

type Action = (prev: ActionResult, formData: FormData) => Promise<ActionResult>;

/** Small form wrapper for admin Server Actions: shows the error / success message under the fields. */
export function ActionForm({ action, children, submitLabel, className, variant = "primary", hideSubmit = false }: { action: Action; children?: ReactNode; submitLabel: string; className?: string; variant?: "primary" | "danger" | "secondary"; hideSubmit?: boolean }) {
  const [state, formAction] = useActionState(action, initialActionResult);
  return (
    <form action={formAction} className={className}>
      {children}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {hideSubmit ? null : <Submit variant={variant}>{submitLabel}</Submit>}
        {state.error ? <span role="alert" className="text-sm text-red-700">{state.error}</span> : null}
        {state.message ? <span role="status" className="text-sm text-green-700">{state.message}</span> : null}
      </div>
    </form>
  );
}

const VARIANTS = {
  primary: "bg-blue-600 text-white hover:bg-blue-700",
  danger: "bg-red-600 text-white hover:bg-red-700",
  secondary: "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50",
};

function Submit({ children, variant }: { children: ReactNode; variant: keyof typeof VARIANTS }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${VARIANTS[variant]}`}>
      {pending ? "Attendere…" : children}
    </button>
  );
}
