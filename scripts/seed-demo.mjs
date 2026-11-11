// Demo data for the customer demo and the carrier job screens — LOCAL Supabase only (D64), never staging/production.
// Usage:  npm run db:local:reset && npm run db:local:seed-demo
// Running it again does not add anything: it prints the existing orders and logins (and sets the seed password
// on the accounts again). For fresh dates (e.g. "Rinuncia bloccata" depends on the clock) reset and seed again.
// Guards, password and helpers: scripts/lib/local-seed.mjs. Manual tests: docs/testy-reczne/corse-padroncino.md.
//
// Creates: the admin, a private customer, two active carriers (Ferri: furgone medio; Galli: camion) and orders in
// every status, priced by the real engine and built like the wizard; then
//   * paid jobs nobody has taken, of different sizes — some too big for a furgone medio (only Galli sees them);
//   * a job accepted by Ferri over 15 minutes ago with pickup within 48 h ("Rinuncia" blocked);
//   * a job accepted by Ferri with pickup in ≥ 48 h ("Rinuncia" allowed).
// Delivered orders and the blocked-Rinuncia job are moved into the past with plain SQL in the local container.
import {
  ADMIN_EMAIL, approveCarrier, carrierAccount, companyDocs, existingUserId, localSql, ok, order, pay, printOrders,
  printPasswordHint, privateCustomer, seedAdmin, service, sqlUuid, user, vehicle,
} from "./lib/local-seed.mjs";

const EMAILS = { customer: "cliente@example.com", ferri: "padroncino@example.com", galli: "padroncino2@example.com" };
const EXPECTED_ORDERS = 15;

function printLogins() {
  console.log("\nLogin:");
  console.log(`  Admin:              ${ADMIN_EMAIL.padEnd(26)} → http://localhost:3000/admin/ordini`);
  console.log(`  Cliente:            ${EMAILS.customer.padEnd(26)} → http://localhost:3000/cliente`);
  console.log(`  Padroncino (Ferri): ${EMAILS.ferri.padEnd(26)} → http://localhost:3000/padroncino  (furgone medio)`);
  console.log(`  Padroncino (Galli): ${EMAILS.galli.padEnd(26)} → http://localhost:3000/padroncino  (camion con sponda)`);
  printPasswordHint();
}

// ---------------------------------------------------------------------------
// Already seeded? Then only refresh the passwords and print.
// ---------------------------------------------------------------------------
const ids = await Promise.all(Object.values(EMAILS).map(existingUserId));
if (ids.some(Boolean)) {
  const customerId = await existingUserId(EMAILS.customer);
  const countOrders = async (filter = (q) => q) => {
    if (!customerId) return 0;
    const r = await filter(service.from("orders").select("id", { count: "exact", head: true }).eq("customer_id", customerId));
    if (r.error) throw new Error(JSON.stringify(r.error));
    return r.count;
  };
  const count = await countOrders();
  // Completion marker: the last step moves the delivered orders into the past.
  const past = await countOrders((q) => q.eq("status", "delivered").lt("delivered_at", new Date(Date.now() - 20 * 86_400_000).toISOString()));
  if (ids.some((id) => !id) || count !== EXPECTED_ORDERS || !past) {
    console.error("Seed demo incompleto (un'esecuzione precedente si è interrotta). Ricomincia da zero:\n  npm run db:local:reset && npm run db:local:seed-demo");
    process.exit(1);
  }
  await seedAdmin();
  for (const email of Object.values(EMAILS)) await user(email);
  console.log("Seed demo già presente: nessun dato aggiunto.\n\nOrdini demo:");
  await printOrders(customerId);
  printLogins();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
const admin = await seedAdmin();
const customer = await privateCustomer({ email: EMAILS.customer, firstName: "Giulia", lastName: "Conti", phone: "+393401112233" });

const ferri = await carrierAccount({ email: EMAILS.ferri, firstName: "Marco", lastName: "Ferri", company: "Ferri Trasporti Srl", vatIndex: 1, phone: "+393405556677" });
await companyDocs(ferri);
const ferriVan = await vehicle(ferri, "FT123AB", { type: "van_medium", payloadKg: 1200 });
await approveCarrier(ferri, admin);

const galli = await carrierAccount({ email: EMAILS.galli, firstName: "Luca", lastName: "Galli", company: "Galli Logistica Srl", vatIndex: 2, phone: "+393408889900" });
await companyDocs(galli);
await vehicle(galli, "GL456CD", { type: "truck_tail_lift", payloadKg: 3000 });
await approveCarrier(galli, admin);

// ---------------------------------------------------------------------------
// Orders of the customer demo
// ---------------------------------------------------------------------------
const mk = (o) => order(customer, o);
const assign = (o) => ok(service.rpc("admin_assign_job", { p_order_id: o.id, p_carrier_id: ferri.id, p_vehicle_id: ferriVan, p_admin_id: admin.id }));
const advance = async (o, ...steps) => {
  for (const to of steps) await ok(service.rpc("admin_advance_order", { p_order_id: o.id, p_admin_id: admin.id, p_to_status: to, p_note: to === "delivered" ? "Consegna demo (seed)" : null }));
};
const accept = (c, o, vehicleId) => ok(c.client.rpc("accept_job", { p_order_id: o.id, p_vehicle_id: vehicleId }));

// 1. In attesa di pagamento
await mk({ from: "milanoCentro", to: "monza", daysAhead: 5, goods: { description: "Divano 3 posti e 4 scatoloni", items: 5, weightKg: 90, largest: { lengthCm: 210, widthCm: 90, heightCm: 85 } }, contacts: ["Giulia Conti", "Paolo Conti"] });
// 2–3. Pagato, da assegnare (furgone medio — visible to both carriers)
await pay(await mk({ from: "milanoNavigli", to: "bergamo", daysAhead: 3, window: "08-10", goods: { description: "Scrivania, sedia ufficio e libreria smontata", items: 8, weightKg: 140 }, packing: 4, contacts: ["Giulia Conti", "Studio Rossi"] }));
await pay(await mk({ from: "milanoNavigli", to: "bergamo", daysAhead: 4, goods: { description: "Mobili camera da letto", items: 12, weightKg: 300, pallets: 2 }, storage: { days: 7, pallets: 2 }, contacts: ["Giulia Conti", "Marta Conti"] }));
// 4. Assegnato (by the admin)
const o4 = await pay(await mk({ from: "milanoCentro", to: "torino", daysAhead: 2, window: "14-16", goods: { description: "Pianoforte digitale e 10 scatoloni di libri", items: 11, weightKg: 250 }, contacts: ["Giulia Conti", "Luca Conti"] }));
await assign(o4);
// 5. Ritirato
const o5 = await pay(await mk({ from: "monza", to: "como", daysAhead: 1, window: "08-10", goods: { description: "Lavatrice e frigorifero", items: 2, weightKg: 160 }, contacts: ["Giulia Conti", "Anna Conti"] }));
await assign(o5); await advance(o5, "picked_up");
// 6. In viaggio
const o6 = await pay(await mk({ from: "como", to: "milanoCentro", daysAhead: 1, window: "12-14", goods: { description: "Bici, 6 scatoloni", items: 7, weightKg: 70 }, contacts: ["Giulia Conti", "Giulia Conti"] }));
await assign(o6); await advance(o6, "picked_up", "in_transit");
// 7–8. Consegnati (moved into the past below)
const o7 = await pay(await mk({ from: "milanoNavigli", to: "milanoCentro", daysAhead: 1, goods: { description: "Armadio due ante", items: 1, weightKg: 80 }, contacts: ["Giulia Conti", "Sara Neri"] }));
await assign(o7); await advance(o7, "picked_up", "in_transit", "delivered");
const o8 = await pay(await mk({ from: "bergamo", to: "milanoNavigli", daysAhead: 1, window: "16-18", goods: { description: "Tavolo e 6 sedie", items: 7, weightKg: 110 }, contacts: ["Giulia Conti", "Giulia Conti"] }));
await assign(o8); await advance(o8, "picked_up", "in_transit", "delivered");
// 9. Scaduto (never paid)
const o9 = await mk({ from: "milanoCentro", to: "monza", daysAhead: 6, goods: { description: "Poltrona", items: 1, weightKg: 30 }, contacts: ["Giulia Conti", "Paolo Conti"] });
await ok(service.rpc("expire_order", { p_order_id: o9.id, p_source: "system_job", p_changed_by: null, p_note: null, p_force: true }));

// ---------------------------------------------------------------------------
// Jobs for the carrier screens (docs/testy-reczne/corse-padroncino.md)
// ---------------------------------------------------------------------------
// 10. Small job — both carriers see it.
await pay(await mk({ from: "milanoCentro", to: "brescia", daysAhead: 3, window: "14-16", vehicle: "van_small", goods: { description: "Poltrona e lampada da terra", items: 2, weightKg: 35 }, contacts: ["Giulia Conti", "Elisa Conti"] }));
// 11. "Già accettata": both carriers open it, the first one accepts, the second gets the D120 message.
await pay(await mk({ from: "monza", to: "novara", daysAhead: 4, window: "08-10", goods: { description: "Frigorifero americano", items: 1, weightKg: 150, largest: { lengthCm: 180, widthCm: 90, heightCm: 75 } }, contacts: ["Giulia Conti", "Bar Centrale"] }));
// 12. Too big for a furgone medio: camion, 6 EUR pallets, 2.2 t — only Galli.
await pay(await mk({ from: "bergamo", to: "brescia", daysAhead: 3, window: "08-10", vehicle: "truck_tail_lift", goods: { description: "Macchinari su 6 pallet", items: 6, weightKg: 2200, pallets: 6 }, contacts: ["Officina Conti", "Magazzino Ricambi"] }));
// 13. Too long for a furgone medio: 4 m counter, furgone grande — only Galli.
await pay(await mk({ from: "novara", to: "milanoNavigli", daysAhead: 5, window: "12-14", vehicle: "van_large", goods: { description: "Bancone bar lungo 4 metri", items: 1, weightKg: 300, largest: { lengthCm: 400, widthCm: 80, heightCm: 110 } }, contacts: ["Bar Centrale", "Giulia Conti"] }));
// 14. Accepted by Ferri, moved 2 h back below, pickup tomorrow → over 15 min and under 48 h: "Rinuncia" blocked.
const j14 = await pay(await mk({ from: "como", to: "bergamo", daysAhead: 1, window: "10-12", goods: { description: "Lavastoviglie e 3 scatoloni", items: 4, weightKg: 90 }, contacts: ["Giulia Conti", "Marta Conti"], notes: "Citofono Conti, secondo piano." }));
await accept(ferri, j14, ferriVan);
// 15. Accepted by Ferri, pickup in 6 days → "Rinuncia" allowed (≥ 48 h before pickup).
const j15 = await pay(await mk({ from: "brescia", to: "milanoCentro", daysAhead: 6, window: "14-16", goods: { description: "Libreria e 15 scatoloni", items: 16, weightKg: 260 }, contacts: ["Giulia Conti", "Paolo Conti"] }));
await accept(ferri, j15, ferriVan);

// ---------------------------------------------------------------------------
// Times: every date of an order back by N days (delivered orders into the past, +1 for the day they were created
// ahead; "Ritirato" / "In viaggio" to this morning). For job 14 only the booking/payment/acceptance times move back
// 2 hours — the pickup stays tomorrow.
// ---------------------------------------------------------------------------
const shiftDays = (id, days) => `
  update public.orders set
    created_at = created_at - interval '${days} days', updated_at = updated_at - interval '${days} days',
    payment_due_at = payment_due_at - interval '${days} days', pickup_window_start = pickup_window_start - interval '${days} days',
    paid_at = paid_at - interval '${days} days', assigned_at = assigned_at - interval '${days} days',
    -- status times only where the order reached that status
    picked_up_at = case when picked_up_at is not null then pickup_window_start - interval '${days} days' + interval '20 minutes' end,
    in_transit_at = case when in_transit_at is not null then pickup_window_start - interval '${days} days' + interval '50 minutes' end,
    delivered_at = case when delivered_at is not null then pickup_window_start - interval '${days} days' + interval '2 hours' end
  where id = ${sqlUuid(id)};
  update public.order_legs set
    pickup_date = pickup_date - ${days}, pickup_window_start = pickup_window_start - interval '${days} days',
    pickup_window_end = pickup_window_end - interval '${days} days'
  where order_id = ${sqlUuid(id)};
  update public.order_status_history set created_at = created_at - interval '${days} days' where order_id = ${sqlUuid(id)};
  update public.payments set created_at = created_at - interval '${days} days' where order_id = ${sqlUuid(id)};`;
const shiftBooking = (id, hours) => `
  update public.orders set
    created_at = created_at - interval '${hours} hours', updated_at = updated_at - interval '${hours} hours',
    payment_due_at = payment_due_at - interval '${hours} hours', paid_at = paid_at - interval '${hours} hours',
    assigned_at = assigned_at - interval '${hours} hours'
  where id = ${sqlUuid(id)};
  update public.order_status_history set created_at = created_at - interval '${hours} hours' where order_id = ${sqlUuid(id)};
  update public.payments set created_at = created_at - interval '${hours} hours' where order_id = ${sqlUuid(id)};`;
localSql(`set local session_replication_role = replica;
${shiftBooking(j14.id, 2)}
${shiftDays(o5.id, 1)}
${shiftDays(o6.id, 1)}
${shiftDays(o7.id, 11)}
${shiftDays(o8.id, 26)}`);

// ---------------------------------------------------------------------------
console.log("\nOrdini demo:");
await printOrders(customer.id);
printLogins();
