"use server";

import { resolveRouteSummary } from "@/lib/booking/server";
import type { ContactFormState } from "@/lib/contact/form";
import { submitContactForm } from "@/lib/contact/submit-form";

// "Al momento non serviamo questa zona" → contact request of kind out_of_area (spec 2a, D125). The browser
// sends only the two place IDs; cities, provinces and distance are resolved on the server (D76), and only
// for a valid, non-bot submission. Invalid place IDs → the request is saved without route fields.
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

export async function sendOutOfAreaAction(_prev: ContactFormState, fd: FormData): Promise<ContactFormState> {
  const pickup = str(fd, "pickupPlaceId");
  const delivery = str(fd, "deliveryPlaceId");
  return submitContactForm(fd, async () =>
    PLACE_ID.test(pickup) && PLACE_ID.test(delivery)
      ? resolveRouteSummary(pickup, delivery)
      : { pickupCity: null, pickupProvince: null, deliveryCity: null, deliveryProvince: null, distanceKm: null },
  );
}
