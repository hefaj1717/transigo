import { BookingPage } from "../booking-page";

export const metadata = { title: "Prenota il facchinaggio – Transigo" };

// Facchinaggio wizard (D151, D158): indirizzo → data e fascia → facchini → ore → piano → cosa spostare →
// preventivo → account → contatti → riepilogo → pagamento. Prices only on the server (/api/booking/porters-quote).
export default function Page({ searchParams }: PageProps<"/prenota/facchini">) {
  return <BookingPage service="facchinaggio" searchParams={searchParams} />;
}
