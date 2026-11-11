// "Deposito" of the customer area (spec 7, D139) — pure: where the goods of an order with storage are now.
// Model A (D117): one carrier, leg 0 = pickup → warehouse, leg 1 = warehouse → delivery. The goods are "in
// magazzino" from the live 'unloaded' step of leg 0 until the live 'loaded' step of leg 1.

export type StorageStep = { leg_index: number; step: string; created_at: string; reverted_at: string | null };
export type StorageLeg = { leg_index: number; pickup_window_start: string };

export type StoragePhase = "incoming" | "stored" | "left" | "delivered";

export const STORAGE_PHASE_LABEL: Record<StoragePhase, string> = {
  incoming: "In arrivo al magazzino",
  stored: "In magazzino",
  left: "Ritirato dal magazzino",
  delivered: "Consegnato",
};

/** Orders shown in "Deposito": paid and not cancelled (the storage is real or done). */
export const STORAGE_VISIBLE_STATUSES = ["paid", "assigned", "picked_up", "in_transit", "delivered", "completed"] as const;

export type StorageView = {
  phase: StoragePhase;
  /** When the goods entered the warehouse (leg 0 unloaded), if they did. */
  storedAt: string | null;
  /** When they left it (leg 1 loaded), if they did. */
  leftAt: string | null;
  /** Planned entry (pickup of leg 0) and paid until = planned pickup from the warehouse (leg 1). */
  plannedEntry: string | null;
  paidUntil: string | null;
};

const live = (steps: StorageStep[], leg: number, step: string) =>
  steps.filter((s) => s.leg_index === leg && s.step === step && !s.reverted_at).sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;

export function storageView(o: { status: string; order_legs: StorageLeg[]; order_leg_steps: StorageStep[] }): StorageView {
  const legs = [...o.order_legs].sort((a, b) => a.leg_index - b.leg_index);
  const plannedEntry = legs.find((l) => l.leg_index === 0)?.pickup_window_start ?? null;
  const paidUntil = legs.find((l) => l.leg_index === 1)?.pickup_window_start ?? null;
  const unloaded = live(o.order_leg_steps, 0, "unloaded");
  const loadedOut = live(o.order_leg_steps, 1, "loaded");
  const storedAt = unloaded?.created_at ?? null;
  const leftAt = loadedOut?.created_at ?? null;

  let phase: StoragePhase;
  if (o.status === "delivered" || o.status === "completed") phase = "delivered";
  else if (leftAt) phase = "left";
  else if (storedAt) phase = "stored";
  else phase = "incoming";
  return { phase, storedAt, leftAt, plannedEntry, paidUntil };
}
