import { appleMapsUrl, googleMapsUrl, telHref } from "@/lib/carriers/execution-ui";

/** One place of the job (pickup or delivery of a leg), as the carrier needs it on the road. */
export type StopInfo = {
  title: string;
  isWarehouse: boolean;
  address: string;
  cityLine: string | null;
  floor: string | null;
  contact: { name: string; phone: string } | null;
  lat: number | null;
  lng: number | null;
  /** Taken-over leg: the goods are not at the pickup address (order_handovers). */
  handoverAddress?: string | null;
};

const linkButton =
  "flex min-h-12 flex-1 items-center justify-center rounded-xl border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-900 active:bg-zinc-100";

/** Current stop: address, floor, contact (big call button), navigation in Google Maps / Apple Maps. */
export function StopCard({ stop }: { stop: StopInfo }) {
  return (
    <section aria-label={stop.title} className="rounded-2xl border-2 border-[#0B3B8C] bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold tracking-wide text-[#0B3B8C] uppercase">{stop.title}</p>
      {stop.handoverAddress ? (
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
          Ritiro merce presso: <span className="font-semibold">{stop.handoverAddress}</span>
        </p>
      ) : null}
      {stop.isWarehouse ? <p className="mt-2 font-medium text-zinc-900">Magazzino Transigo</p> : null}
      <p className="mt-1 text-lg font-semibold break-words text-zinc-900">{stop.address}</p>
      {stop.cityLine ? <p className="text-sm text-zinc-600">{stop.cityLine}</p> : null}
      {stop.floor ? <p className="mt-1 text-sm text-zinc-700">Piano: {stop.floor}</p> : null}
      {stop.contact ? (
        <div className="mt-3">
          <p className="text-sm text-zinc-600">Contatto: <span className="font-medium text-zinc-900">{stop.contact.name}</span></p>
          <a href={telHref(stop.contact.phone)} className="mt-2 flex min-h-12 w-full items-center justify-center rounded-xl bg-green-700 px-4 text-base font-semibold text-white active:bg-green-800">
            Chiama {stop.contact.phone}
          </a>
        </div>
      ) : null}
      {stop.lat !== null && stop.lng !== null && !stop.handoverAddress ? (
        <div className="mt-3 flex gap-2">
          <a href={googleMapsUrl(stop.lat, stop.lng)} target="_blank" rel="noopener noreferrer" className={linkButton}>Google Maps</a>
          <a href={appleMapsUrl(stop.lat, stop.lng)} target="_blank" rel="noopener noreferrer" className={linkButton}>Apple Maps</a>
        </div>
      ) : null}
    </section>
  );
}
