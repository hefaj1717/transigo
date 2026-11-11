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
//   * a job accepted by Ferri with pickup in ≥ 48 h ("Rinuncia" allowed);
//   * two jobs accepted by Ferri with pickup TODAY, to run on the phone (docs/testy-reczne/realizacja-kursu.md):
//     one leg with porters, and one with warehouse (2 legs, porters at pickup and delivery; both legs today);
//   * four jobs of Ferri already under way (krok 6 of docs/plany/realizacja-kursu.md), recorded by his session through
//     the real database functions, with photos (tests/e2e/fixtures/foto.jpg) and a generated signature; the step
//     times are then moved back in the local container so the porter time is realistic:
//       18 accepted, only "Sono arrivato al ritiro"      → admin: "Annulla ultimo passo"
//       19 "In viaggio" with porters, pickup photos       → customer: pickup photos, porter time "in corso"; admin: steps with "posizione"
//       20 delivered with POD yesterday, ~1 h 20 min of porter work (overtime) → customer: "Prova di consegna"; admin: POD, overtime
//       21 warehouse: leg 1 done yesterday, leg 2 in 3 days → carrier: "In magazzino"; admin: "Consenti inizio anticipato"
// Delivered orders and the blocked-Rinuncia job are moved into the past with plain SQL in the local container.
import {
  ADMIN_EMAIL, approveCarrier, carrierAccount, companyDocs, completeDelivery, ensurePorterPackages, existingUserId, legsToTodaySql, localSql, ok, order,
  orderPhoto, pay, printOrders, printPasswordHint, privateCustomer, recordStep, seedAdmin, service, sqlUuid, stepTimesSql, user, vehicle,
} from "./lib/local-seed.mjs";

const EMAILS = { customer: "cliente@example.com", ferri: "padroncino@example.com", galli: "padroncino2@example.com" };
const EXPECTED_ORDERS = 21;
// Orders 18–21 by their goods (unique in the seed), for the guide printed at the end and for tests/e2e.
const EXECUTION_DEMO = {
  "Cucina componibile smontata": "admin: «Annulla ultimo passo» (solo «Sono arrivato al ritiro»)",
  "Trasloco bilocale: armadio, letto e 15 scatoloni": "cliente: foto del ritiro, facchini «in corso»; admin: passi con «posizione»",
  "10 scatoloni di libri e una cassettiera": "cliente: «Prova di consegna»; admin: firma, foto, straordinario facchini",
  "Arredo ufficio: 2 scrivanie e 10 scatoloni": "padroncino: «In magazzino»; admin: «Consenti inizio anticipato» (tratta 2)",
};

function printLogins() {
  console.log("\nLogin:");
  console.log(`  Admin:              ${ADMIN_EMAIL.padEnd(26)} → http://localhost:3000/admin/ordini`);
  console.log(`  Cliente:            ${EMAILS.customer.padEnd(26)} → http://localhost:3000/cliente`);
  console.log(`  Padroncino (Ferri): ${EMAILS.ferri.padEnd(26)} → http://localhost:3000/padroncino  (furgone medio)`);
  console.log(`  Padroncino (Galli): ${EMAILS.galli.padEnd(26)} → http://localhost:3000/padroncino  (camion con sponda)`);
  printPasswordHint();
}

async function printExecutionGuide(customerId) {
  const rows = await ok(service.from("orders").select("id, order_number, goods_description").eq("customer_id", customerId).in("goods_description", Object.keys(EXECUTION_DEMO)).order("order_number"));
  console.log("\nCorse in esecuzione (Ferri) — cosa guardare:");
  for (const r of rows) {
    console.log(`  ${r.order_number}  ${EXECUTION_DEMO[r.goods_description]}`);
    console.log(`          /admin/ordini/${r.id} · /cliente/ordini/${r.id} · /padroncino/le-mie-corse/${r.id}`);
  }
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
  await printExecutionGuide(customerId);
  printLogins();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
const admin = await seedAdmin();
await ensurePorterPackages(admin);
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

// 16–17. Job execution (krok 4): accepted by Ferri, every leg moved to TODAY below (Rome day) — ready to run.
const j16 = await pay(await mk({ from: "milanoCentro", to: "monza", daysAhead: 2, window: "08-10", porters: "monolocale", goods: { description: "Trasloco monolocale: divano, letto, 12 scatoloni", items: 14, weightKg: 400, pickupFloor: 3, pickupElevator: false }, contacts: ["Giulia Conti", "Paolo Conti"], notes: "Citofono Conti. Scala stretta." }));
await accept(ferri, j16, ferriVan);
const j17 = await pay(await mk({ from: "milanoNavigli", to: "bergamo", daysAhead: 2, window: "10-12", porters: "parcels", portersDelivery: "parcels", storage: { days: 1, pallets: 1 }, goods: { description: "8 scatoloni e una cassettiera", items: 9, weightKg: 120 }, contacts: ["Giulia Conti", "Marta Conti"] }));
await accept(ferri, j17, ferriVan);

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
  update public.order_admin_notes set created_at = created_at - interval '${days} days' where order_id = ${sqlUuid(id)};
  update public.payments set created_at = created_at - interval '${days} days' where order_id = ${sqlUuid(id)};`;
const shiftBooking = (id, hours) => `
  update public.orders set
    created_at = created_at - interval '${hours} hours', updated_at = updated_at - interval '${hours} hours',
    payment_due_at = payment_due_at - interval '${hours} hours', paid_at = paid_at - interval '${hours} hours',
    assigned_at = assigned_at - interval '${hours} hours'
  where id = ${sqlUuid(id)};
  update public.order_status_history set created_at = created_at - interval '${hours} hours' where order_id = ${sqlUuid(id)};
  update public.payments set created_at = created_at - interval '${hours} hours' where order_id = ${sqlUuid(id)};`;

// ---------------------------------------------------------------------------
// 18–21. Jobs under way (krok 6, docs/plany/realizacja-kursu.md): accepted by Ferri, moved to their pickup day,
// steps / photos / POD with Ferri's session like the app, then realistic step times (local container SQL).
// ---------------------------------------------------------------------------
const POS = { navigli: { lat: 45.4516, lng: 9.1693 }, como: { lat: 45.8112, lng: 9.0853 }, bergamo: { lat: 45.6947, lng: 9.6693 }, centro: { lat: 45.4668, lng: 9.1856 }, monza: { lat: 45.5845, lng: 9.2744 }, warehouse: { lat: 45.4398, lng: 9.2237 } };
const j18 = await pay(await mk({ from: "milanoNavigli", to: "monza", daysAhead: 1, window: "08-10", goods: { description: "Cucina componibile smontata", items: 6, weightKg: 180 }, contacts: ["Giulia Conti", "Paolo Conti"] }));
const j19 = await pay(await mk({ from: "como", to: "bergamo", daysAhead: 1, window: "08-10", porters: "monolocale", goods: { description: "Trasloco bilocale: armadio, letto e 15 scatoloni", items: 17, weightKg: 450, pickupFloor: 2, pickupElevator: false }, contacts: ["Giulia Conti", "Marta Conti"] }));
const j20 = await pay(await mk({ from: "milanoCentro", to: "monza", daysAhead: 2, window: "08-10", porters: "parcels", goods: { description: "10 scatoloni di libri e una cassettiera", items: 11, weightKg: 200, deliveryFloor: 3, deliveryElevator: false }, contacts: ["Giulia Conti", "Anna Conti"] }));
const j21 = await pay(await mk({ from: "milanoNavigli", to: "bergamo", daysAhead: 1, window: "08-10", porters: "parcels", portersDelivery: "parcels", storage: { days: 4, pallets: 1 }, goods: { description: "Arredo ufficio: 2 scrivanie e 10 scatoloni", items: 12, weightKg: 220 }, contacts: ["Giulia Conti", "Studio Conti"] }));
for (const j of [j18, j19, j20, j21]) await accept(ferri, j, ferriVan);
// 18, 19 → today; 20 → yesterday; 21 → leg 1 yesterday, leg 2 in 3 days (storage 4 days kept).
localSql(`set local session_replication_role = replica;
${shiftDays(j18.id, 1)}
${shiftDays(j19.id, 1)}
${shiftDays(j20.id, 3)}
${shiftDays(j21.id, 2)}`);

await recordStep(ferri, j18.id, 0, "arrived_pickup", POS.navigli);

await recordStep(ferri, j19.id, 0, "arrived_pickup", POS.como);
await orderPhoto(ferri, j19.id, 0, "pickup");
await orderPhoto(ferri, j19.id, 0, "pickup");
await recordStep(ferri, j19.id, 0, "loaded", POS.como);
await recordStep(ferri, j19.id, 0, "departed", POS.como);

const fullLeg = async (j, leg, from, to, pickupPhotos = 1) => {
  await recordStep(ferri, j.id, leg, "arrived_pickup", from);
  for (let i = 0; i < pickupPhotos; i++) await orderPhoto(ferri, j.id, leg, "pickup");
  await recordStep(ferri, j.id, leg, "loaded", from);
  await recordStep(ferri, j.id, leg, "departed", from);
  await recordStep(ferri, j.id, leg, "arrived_delivery", to);
  await orderPhoto(ferri, j.id, leg, "delivery");
  await recordStep(ferri, j.id, leg, "unloaded", to);
};
await fullLeg(j20, 0, POS.centro, POS.monza, 2);
await fullLeg(j21, 0, POS.navigli, POS.warehouse);

// Step times: 19 this morning (45 min of loading so far); 20 yesterday, 45 + 35 = 80 min of porter work (package
// "parcels": 1 h included + 15 min grace → overtime); 21 leg 1 yesterday, 35 + 20 = 55 min.
const legStart = (j, leg = 0) => (min) => `((select pickup_window_start from public.order_legs where order_id = ${sqlUuid(j.id)} and leg_index = ${leg}) + interval '${min} minutes')`;
const ago = (min) => `(now() - interval '${min} minutes')`;
const a20 = legStart(j20);
const a21 = legStart(j21);
localSql(`set local session_replication_role = replica;
update public.order_leg_steps set created_at = ${ago(25)} where order_id = ${sqlUuid(j18.id)};
${stepTimesSql(j19.id, { "0:arrived_pickup": ago(110), "0:loaded": ago(65), "0:departed": ago(60) })}
${stepTimesSql(j20.id, { "0:arrived_pickup": a20(10), "0:loaded": a20(55), "0:departed": a20(60), "0:arrived_delivery": a20(95), "0:unloaded": a20(130) })}
${stepTimesSql(j21.id, { "0:arrived_pickup": a21(5), "0:loaded": a21(40), "0:departed": a21(45), "0:arrived_delivery": a21(70), "0:unloaded": a21(90) })}`);

// 20: POD after the shifted steps, so complete_delivery stores the real porter minutes; then the delivery to yesterday.
await completeDelivery(ferri, j20.id, "Anna Conti", POS.monza);
localSql(`set local session_replication_role = replica;
update public.delivery_proofs set signed_at = ${a20(140)} where order_id = ${sqlUuid(j20.id)};
update public.orders set delivered_at = ${a20(140)} where id = ${sqlUuid(j20.id)};
update public.order_status_history set created_at = ${a20(140)} where order_id = ${sqlUuid(j20.id)} and to_status = 'delivered';`);

localSql(`set local session_replication_role = replica;
${legsToTodaySql(j16.id)}
${legsToTodaySql(j17.id)}
${shiftBooking(j14.id, 2)}
${shiftDays(o5.id, 1)}
${shiftDays(o6.id, 1)}
${shiftDays(o7.id, 11)}
${shiftDays(o8.id, 26)}`);

// ---------------------------------------------------------------------------
console.log("\nOrdini demo:");
await printOrders(customer.id);
await printExecutionGuide(customer.id);
printLogins();
