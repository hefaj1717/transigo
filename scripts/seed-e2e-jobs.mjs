// Jobs for the end-to-end test of the job screen (tests/e2e/) — LOCAL Supabase only (D64), never staging/production.
// Runs after `npm run db:local:seed-demo` (needs its carrier Ferri). Per Playwright project it creates two jobs
// accepted by Ferri with every leg TODAY: one leg with porters, and one with warehouse (2 legs). A separate customer
// keeps the demo seed's order count intact. Prints a JSON line { "<project>": { single, storage } } at the end.
import { ensurePorterPackages, existingUserId, legsToTodaySql, localSql, ok, order, pay, privateCustomer, seedAdmin, service, user } from "./lib/local-seed.mjs";

const projects = process.argv.slice(2);
if (!projects.length) throw new Error("usage: node scripts/seed-e2e-jobs.mjs <project>...");
if (!(await existingUserId("padroncino@example.com"))) throw new Error("Ferri missing: run npm run db:local:seed-demo first");

await ensurePorterPackages(await seedAdmin());
const ferri = await user("padroncino@example.com");
const vehicle = (await ok(service.from("carrier_vehicles").select("id").eq("carrier_id", ferri.id).eq("plate", "FT123AB").single())).id;
const customer = (await existingUserId("e2e@example.com"))
  ? await user("e2e@example.com")
  : await privateCustomer({ email: "e2e@example.com", firstName: "Elena", lastName: "Prova", phone: "+393401234567" });

const out = {};
for (const project of projects) {
  const single = await pay(await order(customer, { from: "milanoCentro", to: "monza", daysAhead: 2, window: "08-10", porters: "monolocale", goods: { description: `E2E ${project}: trasloco monolocale`, items: 10, weightKg: 300 }, contacts: ["Elena Prova", "Paolo Prova"] }));
  const storage = await pay(await order(customer, { from: "milanoNavigli", to: "bergamo", daysAhead: 2, window: "10-12", porters: "parcels", portersDelivery: "parcels", storage: { days: 1, pallets: 1 }, goods: { description: `E2E ${project}: con magazzino`, items: 5, weightKg: 80 }, contacts: ["Elena Prova", "Marta Prova"] }));
  for (const o of [single, storage]) await ok(ferri.client.rpc("accept_job", { p_order_id: o.id, p_vehicle_id: vehicle }));
  localSql(`set local session_replication_role = replica;\n${legsToTodaySql(single.id)}\n${legsToTodaySql(storage.id)}`);
  out[project] = { single: single.id, storage: storage.id };
}
console.log(JSON.stringify(out));
