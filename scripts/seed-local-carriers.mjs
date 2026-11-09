// Test carriers for manual checks of /admin/padroncini — LOCAL Supabase only (D64), never staging/production.
// Usage: npm run db:local:start, npm run db:local:reset, then npm run db:local:seed-carriers.
// Running it again does not add anything: it prints the existing carriers (and sets the seed password again).
// npm run test:rls resets the local database and removes these accounts — run this again afterwards.
// Guards, password and helpers: scripts/lib/local-seed.mjs. Manual test: docs/testy-reczne/admin-padroncini.md.
import {
  ADMIN_EMAIL, approveCarrier, carrierAccount, companyDocs, doc, existingUserId, FUTURE, ok, order, pay,
  printPasswordHint, privateCustomer, seedAdmin, service, user, vehicle,
} from "./lib/local-seed.mjs";

const CARRIERS = [
  // [label, last name, e-mail]
  ["In verifica", "Verdi", "verdi@example.com"],
  ["In verifica", "Viola", "viola@example.com"],
  ["Attivo", "Bianchi", "bianchi@example.com"],
  ["Sospeso", "Neri", "neri@example.com"],
  ["Incompleto", "Gialli", "gialli@example.com"],
  ["Rifiutato", "Rosa", "rosa@example.com"],
];
const CUSTOMER_EMAIL = "cliente-padroncini@example.com";
const EMAILS = [...CARRIERS.map(([, , e]) => e), CUSTOMER_EMAIL];

async function printSummary() {
  console.log(`Admin: ${ADMIN_EMAIL}`);
  for (const [label, name, email] of CARRIERS) {
    const id = await existingUserId(email);
    console.log(`${label.padEnd(11)} Trasporti ${name} Srl`.padEnd(36) + `${email.padEnd(22)} /admin/padroncini/${id}`);
  }
  console.log("Targhe: VE100AA (Verdi), VI100AA (Viola), BI100AA / BI100BB / BI100CC (Bianchi), NE100AA (Neri), RO100AA (Rosa)");
  const jobs = await ok(service.from("orders").select("order_number, status, carriers:carrier_id(company_name)").eq("customer_id", await existingUserId(CUSTOMER_EMAIL)).order("order_number"));
  console.log("Corse assegnate: " + jobs.map((j) => `${j.order_number} → ${j.carriers?.company_name ?? "—"}`).join(", "));
  printPasswordHint();
}

// ---------------------------------------------------------------------------
// Already seeded? Then only refresh the passwords and print.
// ---------------------------------------------------------------------------
const ids = await Promise.all(EMAILS.map(existingUserId));
if (ids.some(Boolean)) {
  // Completion marker: Rosa is rejected in the last step.
  const rosaId = await existingUserId("rosa@example.com");
  const rosa = rosaId ? (await ok(service.from("carriers").select("status").eq("profile_id", rosaId)))[0] : null;
  if (ids.some((id) => !id) || rosa?.status !== "rejected") {
    console.error("Seed padroncini incompleto (un'esecuzione precedente si è interrotta). Ricomincia da zero:\n  npm run db:local:reset && npm run db:local:seed-carriers");
    process.exit(1);
  }
  await seedAdmin();
  for (const email of EMAILS) await user(email);
  console.log("Seed padroncini già presente: nessun dato aggiunto.\n");
  await printSummary();
  process.exit(0);
}

const admin = await seedAdmin();
const customer = await privateCustomer({ email: CUSTOMER_EMAIL, firstName: "Elena", lastName: "Ricci", phone: "+393409990011" });
const account = (name, email, vatIndex) => carrierAccount({ email, firstName: "Mario", lastName: name, company: `Trasporti ${name} Srl`, vatIndex });
async function complete(name, email, vatIndex, plate) {
  const c = await account(name, email, vatIndex);
  await companyDocs(c);
  c.vehicleId = await vehicle(c, plate);
  return c;
}
const assign = (c, vehicleId, o) => ok(service.rpc("admin_assign_job", { p_order_id: o.id, p_carrier_id: c.id, p_vehicle_id: vehicleId, p_admin_id: admin.id }));

// Two carriers waiting for review: B2–B3 reject one, B4 approves the other.
const verdi = await complete("Verdi", "verdi@example.com", 11, "VE100AA");
await ok(verdi.client.rpc("submit_carrier_for_review"));
const viola = await complete("Viola", "viola@example.com", 12, "VI100AA");
await ok(viola.client.rpc("submit_carrier_for_review"));

// Active: BI100CC approved and on a job (D116 warning at "Sospendi"); BI100AA re-verify; BI100BB new; pending doc.
const bianchi = await complete("Bianchi", "bianchi@example.com", 13, "BI100AA");
const bianchiJobVan = await vehicle(bianchi, "BI100CC");
await approveCarrier(bianchi, admin);
await assign(bianchi, bianchiJobVan, await pay(await order(customer, { from: "milanoCentro", to: "monza", daysAhead: 3, goods: { description: "Divano e 5 scatoloni", items: 6, weightKg: 120 }, contacts: ["Elena Ricci", "Paolo Ricci"] })));
await vehicle(bianchi, "BI100BB");                                                                   // new vehicle
await ok(bianchi.client.from("carrier_vehicles").update({ payload_kg: 1500 }).eq("id", bianchi.vehicleId)); // re-verify
await doc(bianchi, "goods_insurance", { expires_at: FUTURE });                                       // pending company doc

// Suspended with a job still assigned (D116: it stays theirs; pickup ≥ 48 h, so they may still release it).
const neri = await complete("Neri", "neri@example.com", 14, "NE100AA");
await approveCarrier(neri, admin);
await assign(neri, neri.vehicleId, await pay(await order(customer, { from: "milanoNavigli", to: "bergamo", daysAhead: 5, window: "14-16", goods: { description: "Cucina smontata", items: 10, weightKg: 350 }, contacts: ["Elena Ricci", "Marta Ricci"] })));
await ok(service.rpc("set_carrier_suspension", { p_carrier_id: neri.id, p_admin_id: admin.id, p_suspend: true, p_reason: "RCA scaduta: carica la nuova polizza." }));
await doc(neri, "insurance_rca", { vehicle_id: neri.vehicleId, expires_at: FUTURE });

const gialli = await account("Gialli", "gialli@example.com", 15);
await doc(gialli, "transport_license");

// Last step = completion marker.
const rosa = await complete("Rosa", "rosa@example.com", 16, "RO100AA");
await ok(rosa.client.rpc("submit_carrier_for_review"));
await ok(service.rpc("decide_carrier_review", { p_carrier_id: rosa.id, p_admin_id: admin.id, p_approve: false, p_reason: "Albo non leggibile." }));

await printSummary();
