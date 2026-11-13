import { BookingPage } from "./booking-page";

export const metadata = { title: "Prenota un trasporto – Transigo" };

// Booking wizard (spec section 6, D70). Steps 1–6 work without an account; the account is required before
// "Contatti" and "Riepilogo". The three wizards share one page body (booking-page.tsx) so the tabs switch instantly.
export default function Page({ searchParams }: PageProps<"/prenota">) {
  return <BookingPage service="trasporto" searchParams={searchParams} />;
}
