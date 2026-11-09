// Demo data for the customer demo — LOCAL Supabase only (D64), never staging/production.
// Usage (once, on a clean database):  npm run db:local:reset && npm run db:local:seed-demo
// Each run adds another set. Prints the test logins at the end.
//
// Creates: an admin, a private customer, one active carrier (furgone medio, everything approved) and orders in
// several statuses, priced by the real engine (src/lib/pricing) from the active price list and built by the
// booking code (src/lib/booking) — the same path as the wizard, through create_order + the payment functions +
// the admin dispatch functions, so prices and status history are consistent. Delivered orders are then moved
// into the past with plain SQL inside the local database container, triggers disabled for that one transaction.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Guard 1: the target must be this repo's local Supabase (127.0.0.1 / localhost, ports 55321 / 55322).
// ---------------------------------------------------------------------------
const status = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const api = new URL(status.API_URL);
const dbUrl = new URL(status.DB_URL);
if (!LOCAL_HOSTS.has(api.hostname) || api.port !== "55321" || !LOCAL_HOSTS.has(dbUrl.hostname) || dbUrl.port !== "55322") {
  console.error(`Refusing to run: ${api.origin} / ${dbUrl.host} is not this repo's local Supabase (127.0.0.1:55321 / :55322).`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");
const { createJiti } = require("jiti");
const root = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": `${root}src`, "server-only": `${root}tests/stubs/server-only.ts` } });
const { loadPricingConfig } = await jiti.import("@/lib/pricing/load");
const { calculatePrice } = await jiti.import("@/lib/pricing/calculate");
const { planLegs, priceInputFor } = await jiti.import("@/lib/booking/build");
const { buildOrderPayload } = await jiti.import("@/lib/booking/order-payload");
const { EMPTY_WIZARD_STATE } = await jiti.import("@/lib/booking/state");

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(status.API_URL, status.SERVICE_ROLE_KEY, opts);
const ok = async (p) => {
  const r = await p;
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.data;
};

/**
 * Plain SQL inside the LOCAL database container (guard 2: docker exec into supabase_db_TransiGo — this repo's
 * local stack, no route to the cloud). Guard 3 inside the transaction: the connection must be the container's
 * local socket (inet_server_addr() is null) and the database must have Supabase's local roles.
 */
function localSql(sql) {
  const res = spawnSync("docker", ["exec", "-i", "supabase_db_TransiGo", "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: `begin;
do $$ begin
  if inet_server_addr() is not null or current_database() <> 'postgres'
     or not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'not the local Supabase database';
  end if;
end $$;
${sql}
commit;`,
    encoding: "utf8",
  });
  if (res.error || res.status !== 0) throw new Error(`local SQL failed: ${res.stderr || res.error}`);
}

const PW = "Prova-12345!";
const FUTURE = "2099-12-31";
const tag = Date.now().toString(36).slice(-4);
const pdf = new Blob(["%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"], { type: "application/pdf" });

async function user(email, meta) {
  const u = await ok(service.auth.admin.createUser({ email, password: PW, email_confirm: true, user_metadata: meta }));
  const client = createClient(status.API_URL, status.ANON_KEY, opts);
  await ok(client.auth.signInWithPassword({ email, password: PW }));
  return { id: u.user.id, email, client };
}

// Valid partita IVA (check digit as in src/lib/auth/italian-ids.ts).
let n = 0;
const vat = () => {
  const d = String(Date.now() % 1e8).padStart(8, "0") + String(++n % 100).padStart(2, "0");
  let sum = 0;
  for (let i = 0; i < 10; i++) { let x = Number(d[i]); if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; } sum += x; }
  return d + ((10 - (sum % 10)) % 10);
};

// ---------------------------------------------------------------------------
// Service area, warehouse, accounts
// ---------------------------------------------------------------------------
await ok(service.from("service_area_provinces").update({ is_active: true }).in("province_code", ["MI", "MB", "BG", "BS", "CO", "VA", "TO", "NO"]));
let warehouse = (await ok(service.from("warehouses").select("id, address, city, province, lat, lng").eq("is_active", true).limit(1)))[0];
if (!warehouse) {
  warehouse = await ok(service.from("warehouses").insert({ name: "Magazzino Transigo Milano", address: "Via Toffetti 20, 20139 Milano MI", city: "Milano", province: "MI", lat: 45.4398, lng: 9.2237, is_active: true }).select("id, address, city, province, lat, lng").single());
}
const settings = await ok(service.from("settings").select("terms_version, privacy_version").single());

const admin = await user(`admin-${tag}@example.com`, { first_name: "Anna", last_name: "Admin" });
await ok(service.from("profiles").update({ role: "admin", first_name: "Anna", last_name: "Admin" }).eq("id", admin.id));

const customer = await user(`cliente-${tag}@example.com`, { first_name: "Giulia", last_name: "Conti" });
await ok(service.from("customers").insert({ profile_id: customer.id, customer_type: "private" }));
const now = new Date();
await ok(service.from("profiles").update({
  first_name: "Giulia", last_name: "Conti", phone: "+393401112233",
  terms_accepted_at: now.toISOString(), terms_version: settings.terms_version,
  privacy_accepted_at: now.toISOString(), privacy_version: settings.privacy_version,
}).eq("id", customer.id));

const carrier = await user(`padroncino-${tag}@example.com`, { role: "padroncino", first_name: "Marco", last_name: "Ferri" });
await ok(service.from("profiles").update({ first_name: "Marco", last_name: "Ferri", phone: "+393405556677" }).eq("id", carrier.id));
await ok(service.from("carriers").insert({
  profile_id: carrier.id, company_name: `Ferri Trasporti ${tag.toUpperCase()} Srl`, vat_number: vat(), fiscal_code: "FRRMRC80A01F205Z",
  hq_street: "Via Lodi 15", hq_city: "Milano", hq_postal_code: "20135", hq_province: "MI", sdi_code: "M5UXCR1",
}));
async function doc(docType, extra = {}) {
  const path = `${carrier.id}/${randomUUID()}.pdf`;
  await ok(carrier.client.storage.from("carrier-documents").upload(path, pdf, { contentType: "application/pdf" }));
  await ok(carrier.client.from("carrier_documents").insert({ carrier_id: carrier.id, doc_type: docType, storage_path: path, file_name: `${docType}.pdf`, mime_type: "application/pdf", size_bytes: 60, ...extra }));
}
const vanId = (await ok(service.from("vehicle_types").select("id").eq("code", "van_medium").single())).id;
const vehicle = await ok(carrier.client.from("carrier_vehicles").insert({ carrier_id: carrier.id, vehicle_type_id: vanId, plate: `FT${tag.toUpperCase()}A`, payload_kg: 1200 }).select("id").single());
await doc("transport_license");
await doc("driving_license", { expires_at: FUTURE });
await doc("vehicle_registration", { vehicle_id: vehicle.id, expires_at: FUTURE });
await doc("insurance_rca", { vehicle_id: vehicle.id, expires_at: FUTURE });
await ok(carrier.client.rpc("submit_carrier_for_review"));
await ok(service.rpc("decide_carrier_review", { p_carrier_id: carrier.id, p_admin_id: admin.id, p_approve: true, p_reason: null }));

// ---------------------------------------------------------------------------
// Orders — priced by the engine, built like the wizard does
// ---------------------------------------------------------------------------
const config = await loadPricingConfig(service);
const PLACES = {
  milanoCentro: { address: "Via Dante 12, 20121 Milano MI", placeId: "demo-milano-dante", lat: 45.4668, lng: 9.1856, city: "Milano", postalCode: "20121", province: "MI" },
  milanoNavigli: { address: "Ripa di Porta Ticinese 55, 20143 Milano MI", placeId: "demo-milano-navigli", lat: 45.4516, lng: 9.1693, city: "Milano", postalCode: "20143", province: "MI" },
  monza: { address: "Via Italia 30, 20900 Monza MB", placeId: "demo-monza", lat: 45.5845, lng: 9.2744, city: "Monza", postalCode: "20900", province: "MB" },
  bergamo: { address: "Via XX Settembre 40, 24122 Bergamo BG", placeId: "demo-bergamo", lat: 45.6947, lng: 9.6693, city: "Bergamo", postalCode: "24122", province: "BG" },
  torino: { address: "Via Garibaldi 20, 10122 Torino TO", placeId: "demo-torino", lat: 45.0737, lng: 7.6806, city: "Torino", postalCode: "10122", province: "TO" },
  como: { address: "Via Vittorio Emanuele II 50, 22100 Como CO", placeId: "demo-como", lat: 45.8112, lng: 9.0853, city: "Como", postalCode: "22100", province: "CO" },
};
const ROUTE_KM = { "milanoCentro-monza": 18, "milanoNavigli-bergamo": 52, "milanoCentro-torino": 143, "monza-como": 38, "bergamo-milanoNavigli": 52, "como-milanoCentro": 49, "milanoNavigli-milanoCentro": 4 };
const romeDate = (daysAhead) => new Date(Date.now() + daysAhead * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });

async function order({ from, to, daysAhead, window = "10-12", goods, packing = 0, storage = null, contacts }) {
  const A = { ...PLACES[from], warehouseId: null };
  const B = { ...PLACES[to], warehouseId: null };
  const state = {
    ...EMPTY_WIZARD_STATE,
    pickup: { placeId: A.placeId, label: A.address, floor: goods.pickupFloor ?? 0, hasElevator: goods.pickupElevator ?? true },
    delivery: { placeId: B.placeId, label: B.address, floor: goods.deliveryFloor ?? 0, hasElevator: goods.deliveryElevator ?? true },
    pickupDate: romeDate(daysAhead),
    pickupWindow: window,
    goods: { ...EMPTY_WIZARD_STATE.goods, description: goods.description, itemsCount: goods.items ?? null, weightKg: goods.weightKg ?? null, largestItem: goods.largest ?? EMPTY_WIZARD_STATE.goods.largestItem, palletsCount: goods.pallets ?? null },
    packingItems: packing,
    storage: storage ? { returnDate: romeDate(daysAhead + storage.days), returnWindow: "14-16", pallets: storage.pallets } : null,
    vehicleTypeId: vanId,
  };
  const wh = { id: warehouse.id, address: warehouse.address, placeId: null, lat: warehouse.lat, lng: warehouse.lng, city: warehouse.city, postalCode: null, province: warehouse.province };
  const plan = planLegs(state, A, B, wh);
  if (!plan.ok) throw new Error(`plan: ${plan.error}`);
  const km = ROUTE_KM[`${from}-${to}`];
  const legs = plan.legs.map((l, i) => ({ ...l, distanceM: (storage ? [12, km][i] : km) * 1000, durationS: Math.round((storage ? [12, km][i] : km) * 75) }));
  const result = calculatePrice(priceInputFor({ state, legs, storageDays: plan.storageDays, storageBillingUnit: config.storageBillingUnit, vehicleTypeId: vanId, customerType: "private", now: new Date() }), config);
  if (!result.ok) throw new Error(`price: ${JSON.stringify(result.error)}`);
  const at = new Date();
  const payload = buildOrderPayload({
    customerId: customer.id, state, vehicleTypeId: vanId, legs, storageDays: plan.storageDays, storageBillingUnit: config.storageBillingUnit,
    quote: result.quote, quotedAt: at, termsVersion: settings.terms_version, termsAcceptedAt: at,
    contacts: { pickupName: contacts[0], pickupPhone: "+393331234567", deliveryName: contacts[1], deliveryPhone: "+393337654321", notes: "" },
    billingDetails: { customer_type: "private", fiscal_code: "CNTGLI85M41F205X", street: "Via Dante 12", city: "Milano", postal_code: "20121", province: "MI" },
  });
  const created = await ok(service.rpc("create_order", { p: payload }));
  return { id: created.id, number: created.order_number, total: result.quote.totalCents };
}

async function pay(o) {
  const session = `cs_test_demo_${randomUUID()}`;
  await ok(service.rpc("start_order_payment", { p_order_id: o.id, p_session_id: session, p_amount_cents: o.total, p_expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
  await ok(service.rpc("confirm_order_payment", { p_session_id: session, p_payment_intent_id: `pi_demo_${randomUUID()}`, p_charge_id: `ch_demo_${randomUUID()}`, p_amount_cents: o.total, p_currency: "eur" }));
}
const assign = (o) => ok(service.rpc("admin_assign_job", { p_order_id: o.id, p_carrier_id: carrier.id, p_vehicle_id: vehicle.id, p_admin_id: admin.id }));
const advance = async (o, ...steps) => {
  for (const to of steps) await ok(service.rpc("admin_advance_order", { p_order_id: o.id, p_admin_id: admin.id, p_to_status: to }));
};

const made = [];
const add = async (label, o) => { made.push([label, o.number]); return o; };

// 1. In attesa di pagamento
await add("In attesa di pagamento", await order({ from: "milanoCentro", to: "monza", daysAhead: 5, goods: { description: "Divano 3 posti e 4 scatoloni", items: 5, weightKg: 90, largest: { lengthCm: 210, widthCm: 90, heightCm: 85 } }, contacts: ["Giulia Conti", "Paolo Conti"] }));
// 2–3. Pagato, da assegnare
await pay(await add("Pagato — da assegnare", await order({ from: "milanoNavigli", to: "bergamo", daysAhead: 3, window: "08-10", goods: { description: "Scrivania, sedia ufficio e libreria smontata", items: 8, weightKg: 140 }, packing: 4, contacts: ["Giulia Conti", "Studio Rossi"] })));
await pay(await add("Pagato — da assegnare (con deposito)", await order({ from: "milanoNavigli", to: "bergamo", daysAhead: 4, goods: { description: "Mobili camera da letto", items: 12, weightKg: 300, pallets: 2 }, storage: { days: 7, pallets: 2 }, contacts: ["Giulia Conti", "Marta Conti"] })));
// 4. Assegnato
const o4 = await add("Assegnato", await order({ from: "milanoCentro", to: "torino", daysAhead: 2, window: "14-16", goods: { description: "Pianoforte digitale e 10 scatoloni di libri", items: 11, weightKg: 250 }, contacts: ["Giulia Conti", "Luca Conti"] }));
await pay(o4); await assign(o4);
// 5. Ritirato
const o5 = await add("Ritirato", await order({ from: "monza", to: "como", daysAhead: 1, window: "08-10", goods: { description: "Lavatrice e frigorifero", items: 2, weightKg: 160 }, contacts: ["Giulia Conti", "Anna Conti"] }));
await pay(o5); await assign(o5); await advance(o5, "picked_up");
// 6. In viaggio
const o6 = await add("In viaggio", await order({ from: "como", to: "milanoCentro", daysAhead: 1, window: "12-14", goods: { description: "Bici, 6 scatoloni", items: 7, weightKg: 70 }, contacts: ["Giulia Conti", "Giulia Conti"] }));
await pay(o6); await assign(o6); await advance(o6, "picked_up", "in_transit");
// 7–8. Consegnati (moved into the past below)
const o7 = await add("Consegnato (10 giorni fa)", await order({ from: "milanoNavigli", to: "milanoCentro", daysAhead: 1, goods: { description: "Armadio due ante", items: 1, weightKg: 80 }, contacts: ["Giulia Conti", "Sara Neri"] }));
await pay(o7); await assign(o7); await advance(o7, "picked_up", "in_transit", "delivered");
const o8 = await add("Consegnato (25 giorni fa)", await order({ from: "bergamo", to: "milanoNavigli", daysAhead: 1, window: "16-18", goods: { description: "Tavolo e 6 sedie", items: 7, weightKg: 110 }, contacts: ["Giulia Conti", "Giulia Conti"] }));
await pay(o8); await assign(o8); await advance(o8, "picked_up", "in_transit", "delivered");
// 9. Scaduto (never paid)
const o9 = await add("Scaduto", await order({ from: "milanoCentro", to: "monza", daysAhead: 6, goods: { description: "Poltrona", items: 1, weightKg: 30 }, contacts: ["Giulia Conti", "Paolo Conti"] }));
await ok(service.rpc("expire_order", { p_order_id: o9.id, p_source: "system_job", p_changed_by: null, p_note: null, p_force: true }));

// Every date of an order back by N days: delivered orders into the past (+1 for the day they were created ahead),
// "Ritirato" / "In viaggio" to this morning (they were created for tomorrow).
const shift = (id, days) => `
  update public.orders set
    created_at = created_at - interval '${days} days', updated_at = updated_at - interval '${days} days',
    payment_due_at = payment_due_at - interval '${days} days', pickup_window_start = pickup_window_start - interval '${days} days',
    paid_at = paid_at - interval '${days} days', assigned_at = assigned_at - interval '${days} days',
    -- status times only where the order reached that status
    picked_up_at = case when picked_up_at is not null then pickup_window_start - interval '${days} days' + interval '20 minutes' end,
    in_transit_at = case when in_transit_at is not null then pickup_window_start - interval '${days} days' + interval '50 minutes' end,
    delivered_at = case when delivered_at is not null then pickup_window_start - interval '${days} days' + interval '2 hours' end
  where id = '${id}';
  update public.order_legs set
    pickup_date = pickup_date - ${days}, pickup_window_start = pickup_window_start - interval '${days} days',
    pickup_window_end = pickup_window_end - interval '${days} days'
  where order_id = '${id}';
  update public.order_status_history set created_at = created_at - interval '${days} days' where order_id = '${id}';
  update public.payments set created_at = created_at - interval '${days} days' where order_id = '${id}';`;
const uuidRe = /^[0-9a-f-]{36}$/;
for (const id of [o5.id, o6.id, o7.id, o8.id]) if (!uuidRe.test(id)) throw new Error("unexpected id");
localSql(`set local session_replication_role = replica;\n${shift(o5.id, 1)}\n${shift(o6.id, 1)}\n${shift(o7.id, 11)}\n${shift(o8.id, 26)}`);

// ---------------------------------------------------------------------------
console.log("\nOrdini demo:");
for (const [label, number] of made) console.log(`  ${number}  ${label}`);
console.log(`\nLogin (password per tutti: ${PW})`);
console.log(`  Admin:       admin-${tag}@example.com      → http://localhost:3000/admin/ordini`);
console.log(`  Cliente:     cliente-${tag}@example.com    → http://localhost:3000/cliente`);
console.log(`  Padroncino:  padroncino-${tag}@example.com → http://localhost:3000/padroncino`);
