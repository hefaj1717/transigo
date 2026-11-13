import { BookingPage } from "../booking-page";

export const metadata = { title: "Prenota il deposito – Transigo" };

// Deposito wizard (D151, D153–D158): box o pallet → periodo (disponibilità) → arrivo della merce → uscita →
// merce → facchini (solo con trasporto) → preventivo → account → contatti → riepilogo → pagamento (tutto subito,
// D172). Prices only on the server (/api/booking/storage-quote).
export default function Page({ searchParams }: PageProps<"/prenota/deposito">) {
  return <BookingPage service="deposito" searchParams={searchParams} />;
}
