"use client";

import { startTransition, useActionState, type FormEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { initialActionResult, type ActionResult } from "@/lib/admin/action-result";

type Action = (prev: ActionResult, formData: FormData) => Promise<ActionResult>;

/**
 * Small form wrapper for admin Server Actions: shows the error / success message under the fields.
 * `keepValues`: the fields keep what the admin typed after the action (React resets a form submitted through
 * `action` — fine for "add" forms, annoying for long edit forms with a validation error).
 */
export function ActionForm({ action, children, submitLabel, className, variant = "primary", hideSubmit = false, keepValues = false }: { action: Action; children?: ReactNode; submitLabel: string; className?: string; variant?: "primary" | "danger" | "secondary"; hideSubmit?: boolean; keepValues?: boolean }) {
  const [state, formAction, isPending] = useActionState(action, initialActionResult);
  const onSubmit = keepValues
    ? (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => formAction(fd));
      }
    : undefined;
  return (
    <form action={formAction} onSubmit={onSubmit} className={className}>
      {children}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {hideSubmit ? null : <Submit variant={variant} pending={isPending}>{submitLabel}</Submit>}
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

function Submit({ children, variant, pending: actionPending }: { children: ReactNode; variant: keyof typeof VARIANTS; pending: boolean }) {
  const pending = useFormStatus().pending || actionPending;
  return (
    <button type="submit" disabled={pending} className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${VARIANTS[variant]}`}>
      {pending ? "Attendere…" : children}
    </button>
  );
}
