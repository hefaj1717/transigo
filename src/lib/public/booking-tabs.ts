// The three booking wizards (D151: Trasporto, Facchinaggio and Deposito are peers). Plain data, shared by the
// server page (fallback heading) and the client tabs.
export const BOOKING_TABS = [
  { key: "trasporto", label: "Trasporto", href: "/prenota", heading: "Prenota un trasporto", title: "Prenota un trasporto – Transigo" },
  { key: "facchinaggio", label: "Facchini", href: "/prenota/facchini", heading: "Prenota il facchinaggio", title: "Prenota il facchinaggio – Transigo" },
  { key: "deposito", label: "Deposito", href: "/prenota/deposito", heading: "Prenota il deposito", title: "Prenota il deposito – Transigo" },
] as const;

export type BookingService = (typeof BOOKING_TABS)[number]["key"];

export function bookingTab(key: BookingService) {
  return BOOKING_TABS.find((t) => t.key === key)!;
}
