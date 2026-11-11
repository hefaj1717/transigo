import { randomUUID } from "node:crypto";
import { service } from "./helpers";
import { check, HOUR, run } from "./job-fixtures";

// Paid Facchinaggio orders for the RLS tests (create_service_order + the payment functions, as in production).
// The province must be active in the service area (each test file activates its own). LOCAL database only (D64).

const line = (sort: number, type: string, net: number) => {
  const vatCents = Math.round((net * 22) / 100);
  return { sort_order: sort, leg_index: 0, line_type: type, label_it: `Voce ${sort}`, quantity: 1, unit_amount_cents: net, net_cents: net, vat_cents: vatCents, gross_cents: net + vatCents, carrier_share_group: "porters" };
};

/** Street, contact, goods and notes of the fixture — none of them may reach a carrier before accepting (D119). */
export const PORTERS_PERSONAL = ["Indipendenza", "40121", "44.49", "Rossi", "+39", "Armadio", "Citofono", "place-porters"];

export async function paidPortersOrder(customerId: string, province: string, o: { persons?: number; hoursAhead?: number } = {}): Promise<string> {
  const priceList = await check(service.from("price_lists").select("id, version").eq("status", "active").single());
  const persons = o.persons ?? 2;
  const start = new Date(Date.now() + (o.hoursAhead ?? 72) * HOUR);
  start.setUTCMinutes(0, 0, 0);
  const lines = [line(0, "porters", persons * 2 * 3_000), line(1, "porters_floors", 3_000)];
  const net = lines.reduce((s, l) => s + l.net_cents, 0);
  const vatCents = lines.reduce((s, l) => s + l.vat_cents, 0);
  const p = {
    service_type: "porters", customer_id: customerId,
    goods_description: "Armadio di Mario Rossi e 10 scatoloni", customer_notes: "Citofono Rossi, scala B",
    site_contact_name: "Mario Rossi", site_contact_phone: "+393331234567",
    porter_job: {
      address: "Via dell'Indipendenza 10, 40121 Bologna BO", place_id: "place-porters", lat: 44.4990, lng: 11.3430,
      city: "Bologna", postal_code: "40121", province,
      job_date: start.toISOString().slice(0, 10), window_start: start.toISOString(), window_end: new Date(start.getTime() + 2 * HOUR).toISOString(),
      floor: 3, has_elevator: false, persons, requested_hours: 2, billed_hours: 2, is_urgent: false, overtime_grace_minutes: 15,
    },
    charges: {
      price_list_id: priceList.id, price_list_version: priceList.version, customer_type: "private", vat_rate_bp: 2200,
      subtotal_cents: net, vat_cents: vatCents, total_cents: net + vatCents, porter_overtime_rate_cents: 3_500,
      billing_details: { first_name: "Mario", last_name: "Rossi", fiscal_code: "RSSMRA80A01F205X", street: "Via Roma 1", city: "Bologna", postal_code: "40121", province },
      terms_accepted_at: new Date().toISOString(), terms_version: "2026-11-01", quoted_at: new Date().toISOString(),
    },
    lines,
    porter_terms: { carrier_amount_cents: 9_600, porter_share_kind: "percent", porter_share_bp: 8000, porter_share_carrier_cents: null, porter_share_net_cents: null },
  };
  const order = (await check(service.rpc("create_service_order", { p }))) as { id: string };
  const session = `cs_test_${randomUUID()}`;
  await run(service.rpc("start_order_payment", { p_order_id: order.id, p_session_id: session, p_amount_cents: net + vatCents, p_expires_at: new Date(Date.now() + HOUR).toISOString() }));
  await run(service.rpc("confirm_order_payment", { p_session_id: session, p_payment_intent_id: `pi_${randomUUID()}`, p_charge_id: `ch_${randomUUID()}`, p_amount_cents: net + vatCents, p_currency: "eur" }));
  return order.id;
}
