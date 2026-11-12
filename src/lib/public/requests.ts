// Calculator → booking link (D162). Facchinaggio: the calculator leads to the wizard /prenota/facchini (step 6),
// which reads the same parameters (parsePortersPrefill). Deposito: the wizard /prenota/deposito (step 7,
// parseStoragePrefill). /contatti still pre-fills the message from the same parameters (links already shared).
// portersContactHref() keeps the /contatti request for Facchinaggio outside the service area.
//
// The query string is user-controlled: parsing accepts only known keys with integer values in range and a box
// code that exists in the active price list. Nothing else reaches the message.

import { PALLETS_MAX, STORAGE_MAX_DAYS, type PortersEstimateInput, type PublicRates, type StorageEstimateInput } from "./rates";

const REQUEST_PATH = { facchinaggio: "/prenota/facchini", deposito: "/prenota/deposito" } as const;

const portersQuery = (input: PortersEstimateInput) =>
  new URLSearchParams({
    servizio: "facchinaggio",
    persone: String(input.persons),
    ore: String(input.hours),
    piano: String(input.floor),
    ascensore: input.hasElevator ? "1" : "0",
  });

export function portersRequestHref(input: PortersEstimateInput): string {
  return `${REQUEST_PATH.facchinaggio}?${portersQuery(input)}`;
}

/** Contact request for Facchinaggio (e.g. outside the service area): /contatti with the message pre-filled. */
export function portersContactHref(input: PortersEstimateInput): string {
  return `/contatti?${portersQuery(input)}`;
}

export function storageRequestHref(input: StorageEstimateInput): string {
  const q = new URLSearchParams({ servizio: "deposito", giorni: String(input.days) });
  if (input.unit === "box") q.set("box", input.boxCode);
  else q.set("pallet", String(input.pallets));
  return `${REQUEST_PATH.deposito}?${q}`;
}

type Params = { get(name: string): string | null };

function int(p: Params, key: string, min: number, max: number): number | null {
  const raw = p.get(key);
  if (raw === null || !/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

export function parsePortersRequest(p: Params, rates: PublicRates | null): PortersEstimateInput | null {
  const r = rates?.porters;
  if (p.get("servizio") !== "facchinaggio" || !r) return null;
  const persons = int(p, "persone", r.minPersons, r.maxPersons);
  const hours = int(p, "ore", 1, r.maxHours);
  const floor = int(p, "piano", 0, r.maxFloor);
  const lift = p.get("ascensore");
  if (persons === null || hours === null || floor === null || (lift !== "0" && lift !== "1")) return null;
  return { persons, hours, floor, hasElevator: lift === "1" };
}

export function parseStorageRequest(p: Params, rates: PublicRates | null): StorageEstimateInput | null {
  const s = rates?.storage;
  if (p.get("servizio") !== "deposito" || !s) return null;
  const days = int(p, "giorni", 1, STORAGE_MAX_DAYS);
  if (days === null) return null;
  const boxCode = p.get("box");
  if (boxCode !== null) {
    return s.boxes.some((b) => b.code === boxCode) ? { unit: "box", boxCode, days } : null;
  }
  const pallets = int(p, "pallet", 1, PALLETS_MAX);
  return pallets !== null && s.pallets ? { unit: "pallet", pallets, days } : null;
}

const floorText = (floor: number, lift: boolean) => (floor === 0 ? "piano terra" : `${floor}° piano ${lift ? "con" : "senza"} ascensore`);

/** Pre-filled message of the contact form, or null when the query string holds no valid request. */
export function requestMessage(p: Params, rates: PublicRates | null): string | null {
  const porters = parsePortersRequest(p, rates);
  if (porters) {
    return `Vorrei prenotare il facchinaggio: ${porters.persons} facchini per circa ${porters.hours} ${porters.hours === 1 ? "ora" : "ore"}, ${floorText(porters.floor, porters.hasElevator)}.\nIndirizzo e data: `;
  }
  const storage = parseStorageRequest(p, rates);
  if (storage) {
    const days = `${storage.days} ${storage.days === 1 ? "giorno" : "giorni"}`;
    if (storage.unit === "box") {
      const box = rates!.storage!.boxes.find((b) => b.code === storage.boxCode)!;
      return `Vorrei prenotare un deposito: ${box.label} (${box.volumeM3} m³) per ${days}.\nData di inizio: `;
    }
    return `Vorrei prenotare un deposito: ${storage.pallets} pallet per ${days}.\nData di inizio: `;
  }
  return null;
}
