import type { MyJobDetail } from "@/lib/carriers/jobs-server";
import type { LegStops } from "./job-execution";
import type { StopInfo } from "./stop-card";

/** Pickup and delivery of every leg, as the job screen shows the current one (contacts: first pickup, last delivery). */
export function legStops(job: MyJobDetail): LegStops[] {
  const last = job.legs.length - 1;
  return job.legs.map((leg, i) => {
    const a = job.addresses.find((x) => x.legIndex === leg.legIndex);
    const stop = (title: string, s: typeof leg.from, address: string | undefined, lat: number | undefined, lng: number | undefined, floor: string | null, contact: StopInfo["contact"]): StopInfo => ({
      title,
      isWarehouse: s.isWarehouse,
      address: address ?? `${s.city} (${s.province})`,
      cityLine: address?.includes(s.city) ? null : `${s.city} (${s.province})`,
      floor,
      contact,
      lat: lat ?? null,
      lng: lng ?? null,
    });
    const multi = job.legs.length > 1 ? ` · tratta ${leg.legIndex + 1}` : "";
    return {
      legIndex: leg.legIndex,
      pickup: stop(`Ritiro${multi}`, leg.from, a?.pickupAddress, a?.pickupLat, a?.pickupLng, leg.pickupFloor, i === 0 && !leg.from.isWarehouse ? job.pickupContact : null),
      delivery: stop(`Consegna${multi}`, leg.to, a?.deliveryAddress, a?.deliveryLat, a?.deliveryLng, leg.deliveryFloor, i === last && !leg.to.isWarehouse ? job.deliveryContact : null),
    };
  });
}
