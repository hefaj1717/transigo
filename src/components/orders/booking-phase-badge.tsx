import { BOOKING_PHASE_LABEL, BOOKING_PHASE_TONE, type BookingPhase, type BookingPhaseTone } from "@/lib/orders/booking-phase";

const TONE_CLASS: Record<BookingPhaseTone, string> = {
  info: "bg-brand-50 text-brand-800",
  progress: "bg-brand-100 text-brand-900",
  success: "bg-accent-100 text-accent-800",
  warning: "bg-amber-100 text-amber-900",
  muted: "bg-zinc-100 text-zinc-500",
};

/** Where the goods of a storage booking are (booking-phase.ts) — the same badge for the customer and the admin. */
export function BookingPhaseBadge({ phase }: { phase: BookingPhase }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[BOOKING_PHASE_TONE[phase]]}`}>{BOOKING_PHASE_LABEL[phase]}</span>;
}
