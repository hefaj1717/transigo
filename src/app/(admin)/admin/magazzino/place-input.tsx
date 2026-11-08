"use client";

import { useState } from "react";
import { AddressField } from "@/app/(public)/prenota/address-field";

/** Address autocomplete that submits the chosen Google place ID as a hidden field. */
export function PlaceInput({ id, label }: { id: string; label: string }) {
  const [place, setPlace] = useState<{ placeId: string; label: string } | null>(null);
  return (
    <div>
      <AddressField id={id} label={label} value={place ? { ...place, floor: 0, hasElevator: false } : null} onChange={setPlace} />
      <input type="hidden" name="place_id" value={place?.placeId ?? ""} />
    </div>
  );
}
