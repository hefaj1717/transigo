import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { groupFilter, groupRootId, orderGroup, type GroupMember, type GroupMemberRow } from "./order-group";
import { bookingEntries, bookingGroupRoots, type BookingEntry, type GroupOrderRow, type StorageOrderRow } from "./storage-bookings";

// Loads the whole group (D153) of an order. `db` is either the service-role client (after the caller checked the
// session) or a session client — RLS then decides what is visible (a customer sees its whole group).

const BASE = "id, order_number, service_type, parent_order_id, created_at";

export type LoadedGroup<T extends GroupMemberRow> = { root: GroupMember<T>; members: GroupMember<T>[] };

/** The group of `orderId` with `extra` columns selected on every member; null when the order is not visible. */
export async function loadOrderGroup<T extends GroupMemberRow = GroupMemberRow>(db: SupabaseClient, orderId: string, extra = ""): Promise<LoadedGroup<T> | null> {
  const { data: o, error } = await db.from("orders").select("id, parent_order_id").eq("id", orderId).maybeSingle();
  if (error) throw new Error(`order group: ${error.message}`);
  if (!o) return null;
  const select = extra ? `${BASE}, ${extra}` : BASE;
  const { data: rows, error: rowsError } = await db.from("orders").select(select).or(groupFilter(groupRootId(o))).limit(10);
  if (rowsError) throw new Error(`order group: ${rowsError.message}`);
  return orderGroup((rows ?? []) as unknown as T[]);
}

// ---------------------------------------------------------------------------
// Storage bookings with their chains — "Deposito" (customer session) and "Magazzino" (admin session)
// ---------------------------------------------------------------------------

/**
 * Storage orders (`select` must include the columns of StorageOrderRow) plus the other orders of their groups,
 * joined by bookingEntries(). With a customer session RLS limits both reads to the customer's own orders.
 */
export async function loadStorageBookings<S extends StorageOrderRow>(db: SupabaseClient, select: string, today: string): Promise<BookingEntry<S, GroupOrderRow>[]> {
  const { data, error } = await db.from("orders").select(`${BASE}, ${select}`).eq("service_type", "storage").order("created_at", { ascending: false }).limit(300);
  if (error) throw new Error(`storage bookings: ${error.message}`);
  const storage = (data ?? []) as unknown as S[];
  const roots = bookingGroupRoots(storage);
  if (!roots.length) return [];
  const groupSelect = `${BASE}, status`;
  const [byId, byParent] = await Promise.all([
    db.from("orders").select(groupSelect).in("id", roots),
    db.from("orders").select(groupSelect).in("parent_order_id", roots),
  ]);
  if (byId.error || byParent.error) throw new Error(`storage bookings: ${(byId.error ?? byParent.error)!.message}`);
  const related = [...(byId.data ?? []), ...(byParent.data ?? [])] as unknown as GroupOrderRow[];
  return bookingEntries(storage, related, today);
}
