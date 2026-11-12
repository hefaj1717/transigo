// Storage bookings (warehouse_bookings, D153) for the lists "Deposito" (customer) and "Magazzino" (admin) — pure.
// A booking's phase depends on the transports of its chain, so the list loads the storage orders and the other
// orders of their groups and joins them here. Tested in storage-bookings.test.ts.
import { groupBookingPhase, type BookingPhase, type BookingPhaseInput } from "./booking-phase";
import { groupRootId, orderGroup, type GroupMember, type GroupMemberRow } from "./order-group";

export type StorageOrderRow = GroupMemberRow & {
  status: string;
  warehouse_bookings: (BookingPhaseInput["booking"] & { unit: string; box_code: string | null; pallets: number | null; warehouse_id?: string }) | null;
};

export type GroupOrderRow = GroupMemberRow & { status: string };

export type BookingEntry<S extends StorageOrderRow, G extends GroupOrderRow> = {
  order: S;
  booking: NonNullable<S["warehouse_bookings"]>;
  phase: BookingPhase;
  /** The whole group in chain order (just the storage order when it is alone). */
  members: GroupMember<S | G>[];
};

/** Root ids of the groups of these storage orders — load their other orders with them. */
export const bookingGroupRoots = (rows: StorageOrderRow[]) => [...new Set(rows.map(groupRootId))];

export function bookingEntries<S extends StorageOrderRow, G extends GroupOrderRow>(storage: S[], related: G[], today: string): BookingEntry<S, G>[] {
  return storage.flatMap((order) => {
    const booking = order.warehouse_bookings;
    if (!booking) return [];
    const root = groupRootId(order);
    const others = related.filter((r) => r.id !== order.id && (r.id === root || r.parent_order_id === root) && r.service_type !== "storage");
    const rows: (S | G)[] = [order, ...others];
    // Defensive: a group without its root among the rows (should not happen) → the storage order alone.
    const members = rows.some((r) => r.parent_order_id === null) ? orderGroup(rows).members : orderGroup([{ ...order, parent_order_id: null }]).members;
    const phase = groupBookingPhase(members.map((m) => ({ ...m, warehouse_bookings: m.id === order.id ? booking : null })), today);
    return phase ? [{ order, booking: booking as NonNullable<S["warehouse_bookings"]>, phase, members }] : [];
  });
}

/** What is in the warehouse now (phases "stored" and "ended"): boxes per size and pallets. */
export function occupancy(entries: { phase: BookingPhase; booking: { unit: string; box_code: string | null; pallets: number | null } }[]) {
  const boxes: Record<string, number> = {};
  let pallets = 0;
  for (const e of entries) {
    if (e.phase !== "stored" && e.phase !== "ended") continue;
    if (e.booking.unit === "box" && e.booking.box_code) boxes[e.booking.box_code] = (boxes[e.booking.box_code] ?? 0) + 1;
    else pallets += e.booking.pallets ?? 0;
  }
  return { boxes, pallets };
}
