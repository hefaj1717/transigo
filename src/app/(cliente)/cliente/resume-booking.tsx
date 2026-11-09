"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { WIZARD_STORAGE_KEY } from "@/lib/booking/state";

// Shows "resume booking" when this browser still has a wizard state (D78), e.g. after confirming the
// e-mail of a new account in the middle of a booking.
const subscribe = () => () => {};
function hasDraft(): boolean {
  try {
    return !!window.localStorage.getItem(WIZARD_STORAGE_KEY);
  } catch {
    return false;
  }
}

export function ResumeBooking() {
  const draft = useSyncExternalStore(subscribe, hasDraft, () => false);
  if (!draft) return null;
  return (
    <div className="mb-6 rounded-md border border-brand-200 bg-brand-50 p-4 text-sm text-brand-900">
      Hai una prenotazione in corso.{" "}
      <Link href="/prenota?passo=account" className="font-medium underline">Riprendi la prenotazione</Link>
    </div>
  );
}
