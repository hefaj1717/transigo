import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { groupFilter, groupRootId, orderGroup, type GroupMember, type GroupMemberRow } from "./order-group";

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
