"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({ children, pendingText = "Attendere…" }: { children: React.ReactNode; pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-60"
    >
      {pending ? pendingText : children}
    </button>
  );
}
