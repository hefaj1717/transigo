import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail, type SendOptions } from "@/lib/notifications/email";
import {
  ORDER_ASSIGNED_TEMPLATE,
  ORDER_DELIVERED_TEMPLATE,
  renderOrderAssignedEmail,
  renderOrderDeliveredEmail,
} from "@/lib/notifications/templates/order-customer-updates";

// Customer e-mails after dispatch changes (spec 13), through the outbox (D93). order_assigned is keyed by the
// assignment time (D129): every NEW assignment (after "Rinuncia" or "Rimuovi padroncino") sends the customer the
// current carrier, a repeated call for the same assignment does not. order_delivered: once per order.
// Callers never undo the status change when an e-mail fails.

type Leg = { leg_index: number; pickup_city: string; delivery_city: string; pickup_window_start: string; pickup_window_end: string };

async function loadOrder(db: SupabaseClient, orderId: string) {
  const { data: o, error } = await db
    .from("orders")
    .select("id, order_number, customer_id, carrier_id, carrier_vehicle_id, assigned_at, delivered_at, order_legs(leg_index, pickup_city, delivery_city, pickup_window_start, pickup_window_end)")
    .eq("id", orderId)
    .single();
  if (error || !o) throw new Error(`order for e-mail: ${error?.message ?? "not found"}`);
  const { data: profile } = await db.from("profiles").select("email, first_name").eq("id", o.customer_id).single();
  if (!profile?.email) throw new Error("customer e-mail not found");
  const legs = [...(o.order_legs as Leg[])].sort((a, b) => a.leg_index - b.leg_index);
  return { o, profile, legs };
}

export async function sendOrderAssignedEmail(db: SupabaseClient, orderId: string, appUrl: string): Promise<void> {
  const { o, profile, legs } = await loadOrder(db, orderId);
  if (!o.carrier_id || !o.assigned_at) throw new Error("order has no carrier");
  const [{ data: carrier }, { data: person }, { data: vehicle }] = await Promise.all([
    db.from("carriers").select("company_name").eq("profile_id", o.carrier_id).single(),
    db.from("profiles").select("first_name").eq("id", o.carrier_id).single(),
    o.carrier_vehicle_id
      ? db.from("carrier_vehicles").select("plate, vehicle_types(name_it)").eq("id", o.carrier_vehicle_id).single()
      : Promise.resolve({ data: null }),
  ]);
  const v = vehicle as { plate: string; vehicle_types: { name_it: string } | null } | null;
  const rendered = renderOrderAssignedEmail({
    firstName: profile.first_name,
    orderNumber: o.order_number,
    pickupCity: legs[0].pickup_city,
    deliveryCity: legs[legs.length - 1].delivery_city,
    orderUrl: `${appUrl}/cliente/ordini/${o.id}`,
    carrierFirstName: person?.first_name ?? null,
    carrierCompany: carrier?.company_name ?? "Trasportatore Transigo",
    vehicleType: v?.vehicle_types?.name_it ?? null,
    plate: v?.plate ?? null,
    pickupWindowStart: new Date(legs[0].pickup_window_start),
    pickupWindowEnd: new Date(legs[0].pickup_window_end),
  });
  await sendEmail(db, {
    ...rendered,
    templateCode: ORDER_ASSIGNED_TEMPLATE,
    to: profile.email,
    recipientId: o.customer_id,
    orderId: o.id,
    eventKey: `assigned:${new Date(o.assigned_at).toISOString()}`, // this assignment (D129)
  });
}

export async function sendOrderDeliveredEmail(db: SupabaseClient, orderId: string, appUrl: string, opts: SendOptions = {}): Promise<void> {
  const { o, profile, legs } = await loadOrder(db, orderId);
  const rendered = renderOrderDeliveredEmail({
    firstName: profile.first_name,
    orderNumber: o.order_number,
    pickupCity: legs[0].pickup_city,
    deliveryCity: legs[legs.length - 1].delivery_city,
    orderUrl: `${appUrl}/cliente/ordini/${o.id}`,
    deliveredAt: new Date(o.delivered_at ?? Date.now()),
  });
  await sendEmail(db, { ...rendered, templateCode: ORDER_DELIVERED_TEMPLATE, to: profile.email, recipientId: o.customer_id, orderId: o.id }, opts);
}
