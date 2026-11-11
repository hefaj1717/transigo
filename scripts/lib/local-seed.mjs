// Shared helpers for the LOCAL seed scripts (seed-demo.mjs, seed-local-carriers.mjs) — D64: local Supabase only,
// never staging/production.
//
// Safety:
//   * guard 1: SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL, when set, must point at the local stack — otherwise refuse;
//   * guard 2: `supabase status` must report this repo's local stack (127.0.0.1 / localhost, ports 55321 / 55322);
//     the keys come from there (no secrets in files);
//   * guard 3: plain SQL runs only through `docker exec` into supabase_db_TransiGo, with a check inside the
//     transaction that the connection is the container's local socket.
//
// Idempotency: every seed account has a fixed e-mail and is found-or-created; each script checks a completion
// marker before creating orders, so running it again prints the existing data instead of adding a second set.
//
// Password: never in the repo. Taken from SEED_PASSWORD, else from .seed-local/password (git-ignored), else
// generated once and saved there. Every run sets it on every seed account it touches, so logins always match.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");
export const root = fileURLToPath(new URL("../..", import.meta.url));

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
export function isLocalApiUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname) && u.port === "55321";
  } catch {
    return false;
  }
}

function refuse(message) {
  console.error(`Refusing to run: ${message}`);
  process.exit(1);
}

for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) {
  const v = process.env[key];
  if (v && !isLocalApiUrl(v)) refuse(`${key}=${v} is not this repo's local Supabase (http://127.0.0.1:55321).`);
}

let status;
try {
  status = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
} catch {
  refuse("local Supabase is not running (npm run db:local:start).");
}
{
  const db = new URL(status.DB_URL);
  if (!isLocalApiUrl(status.API_URL) || !LOCAL_HOSTS.has(db.hostname) || db.port !== "55322") {
    refuse(`${status.API_URL} / ${db.host} is not this repo's local Supabase (127.0.0.1:55321 / :55322).`);
  }
}
export const API_URL = status.API_URL;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
export const service = createClient(API_URL, status.SERVICE_ROLE_KEY, opts);

export const ok = async (p) => {
  const r = await p;
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.data;
};

/** Plain SQL inside the LOCAL database container (guard 3 inside the transaction). */
export function localSql(sql) {
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const sqlUuid = (id) => {
  if (!UUID_RE.test(id)) throw new Error(`unexpected id ${id}`);
  return `'${id}'`;
};

// ---------------------------------------------------------------------------
// Password (outside the repo)
// ---------------------------------------------------------------------------
const PASSWORD_DIR = `${root}.seed-local`;
export const PASSWORD_FILE = `${PASSWORD_DIR}/password`;
function seedPassword() {
  if (process.env.SEED_PASSWORD) {
    if (process.env.SEED_PASSWORD.length < 10) refuse("SEED_PASSWORD must have at least 10 characters.");
    return process.env.SEED_PASSWORD;
  }
  if (existsSync(PASSWORD_FILE)) {
    const saved = readFileSync(PASSWORD_FILE, "utf8").trim();
    if (saved) return saved;
  }
  // Letters and digits only (easy to type), plus a fixed suffix for any "upper/lower/digit/symbol" policy.
  const pw = `${randomBytes(12).toString("base64url").replace(/[-_]/g, "x")}-Aa1`;
  mkdirSync(PASSWORD_DIR, { recursive: true });
  writeFileSync(PASSWORD_FILE, `${pw}\n`, { mode: 0o600 });
  return pw;
}
export const PW = seedPassword();

// ---------------------------------------------------------------------------
// Accounts (found by e-mail, else created)
// ---------------------------------------------------------------------------
let usersByEmail; // Promise<Map<email, user>>, loaded once (a plain Map filled lazily would race under Promise.all)
function users() {
  usersByEmail ??= (async () => {
    const map = new Map();
    for (let page = 1; ; page++) {
      const { users: batch } = await ok(service.auth.admin.listUsers({ page, perPage: 1000 }));
      for (const u of batch) map.set(u.email, u);
      if (batch.length < 1000) return map;
    }
  })();
  return usersByEmail;
}
export async function existingUserId(email) {
  return (await users()).get(email)?.id ?? null;
}

/** Finds or creates the account, sets PW on it and returns a signed-in client. `created` tells which happened. */
export async function user(email, meta = {}) {
  let id = await existingUserId(email);
  const created = !id;
  if (created) {
    id = (await ok(service.auth.admin.createUser({ email, password: PW, email_confirm: true, user_metadata: meta }))).user.id;
    (await users()).set(email, { id, email });
  } else {
    await ok(service.auth.admin.updateUserById(id, { password: PW }));
  }
  const client = createClient(API_URL, status.ANON_KEY, opts);
  await ok(client.auth.signInWithPassword({ email, password: PW }));
  return { id, email, client, created };
}

/** The shared admin of both seeds (same e-mail, so running both scripts gives one admin). */
export const ADMIN_EMAIL = "admin@example.com";
export async function seedAdmin() {
  const a = await user(ADMIN_EMAIL, { first_name: "Anna", last_name: "Admin" });
  await ok(service.from("profiles").update({ role: "admin", first_name: "Anna", last_name: "Admin" }).eq("id", a.id));
  return a;
}

/** Every leg of the order to TODAY (Europe/Rome): leg 1 from 08:00, leg 2 from 18:00 — "Sono arrivato al ritiro" works now. */
export const legsToTodaySql = (id) => `
  update public.order_legs set
    pickup_date = (now() at time zone 'Europe/Rome')::date,
    pickup_window_start = (((now() at time zone 'Europe/Rome')::date + case when leg_index = 0 then time '08:00' else time '18:00' end) at time zone 'Europe/Rome'),
    pickup_window_end = (((now() at time zone 'Europe/Rome')::date + case when leg_index = 0 then time '10:00' else time '20:00' end) at time zone 'Europe/Rome')
  where order_id = ${sqlUuid(id)};
  update public.orders o set pickup_window_start = l.pickup_window_start
    from public.order_legs l where l.order_id = o.id and l.leg_index = 0 and o.id = ${sqlUuid(id)};`;

/**
 * Porters (D67) need a price list with porter packages; the migrations' list v1 has none. When the active list
 * lacks them, the admin clones it (clone_price_list adds the placeholder packages and the overtime rule) and
 * publishes the clone — exactly what "Crea bozza" → "Pubblica" does in /admin/listini. LOCAL database only.
 */
export async function ensurePorterPackages(admin) {
  const active = await ok(service.from("price_lists").select("id, version").eq("status", "active").single());
  const packages = await ok(service.from("price_list_porter_packages").select("code").eq("price_list_id", active.id));
  if (packages.length) return;
  const draftId = await ok(admin.client.rpc("clone_price_list", { p_source_id: active.id }));
  await ok(admin.client.rpc("publish_price_list", { p_price_list_id: draftId }));
  console.log(`Listino: pubblicata una nuova versione con i pacchetti facchini (da v${active.version}).`);
}

/** A valid, deterministic partita IVA (check digit as in src/lib/auth/italian-ids.ts); `k` keeps them unique. */
export function vat(k) {
  const d = String(5_550_000_000 + k);
  let sum = 0;
  for (let i = 0; i < 10; i++) { let x = Number(d[i]); if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; } sum += x; }
  return d + ((10 - (sum % 10)) % 10);
}

export const FUTURE = "2099-12-31";
const pdf = new Blob(["%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"], { type: "application/pdf" });

/** Uploads a tiny PDF with the carrier's own session and registers it. */
export async function doc(c, docType, extra = {}) {
  const path = `${c.id}/${randomUUID()}.pdf`;
  await ok(c.client.storage.from("carrier-documents").upload(path, pdf, { contentType: "application/pdf" }));
  return (await ok(c.client.from("carrier_documents").insert({ carrier_id: c.id, doc_type: docType, storage_path: path, file_name: `${docType}.pdf`, mime_type: "application/pdf", size_bytes: 60, ...extra }).select("id").single())).id;
}

let vehicleTypes;
export async function vehicleTypeId(code) {
  if (!vehicleTypes) vehicleTypes = new Map((await ok(service.from("vehicle_types").select("id, code"))).map((t) => [t.code, t.id]));
  const id = vehicleTypes.get(code);
  if (!id) throw new Error(`unknown vehicle type ${code}`);
  return id;
}

/** Adds a vehicle with its two documents (with the carrier's session). */
export async function vehicle(c, plate, { type = "van_medium", payloadKg = 1200, docs = true } = {}) {
  const v = await ok(c.client.from("carrier_vehicles").insert({ carrier_id: c.id, vehicle_type_id: await vehicleTypeId(type), plate, payload_kg: payloadKg }).select("id").single());
  if (docs) {
    await doc(c, "vehicle_registration", { vehicle_id: v.id, expires_at: FUTURE });
    await doc(c, "insurance_rca", { vehicle_id: v.id, expires_at: FUTURE });
  }
  return v.id;
}

/** Carrier row + company documents. */
export async function carrierAccount({ email, firstName, lastName, company, vatIndex, phone = null }) {
  const c = await user(email, { role: "padroncino", first_name: firstName, last_name: lastName });
  await ok(service.from("profiles").update({ first_name: firstName, last_name: lastName, phone }).eq("id", c.id));
  await ok(service.from("carriers").insert({
    profile_id: c.id, company_name: company, vat_number: vat(vatIndex), fiscal_code: "RSSMRA80A01H501U",
    hq_street: "Via Lodi 15", hq_city: "Milano", hq_postal_code: "20135", hq_province: "MI", sdi_code: "M5UXCR1",
  }));
  c.company = company;
  return c;
}
export async function companyDocs(c) {
  await doc(c, "transport_license");
  await doc(c, "driving_license", { expires_at: FUTURE });
}
export async function approveCarrier(c, admin) {
  await ok(c.client.rpc("submit_carrier_for_review"));
  await ok(service.rpc("decide_carrier_review", { p_carrier_id: c.id, p_admin_id: admin.id, p_approve: true, p_reason: null }));
}

// ---------------------------------------------------------------------------
// Customers and orders — priced by the real engine (src/lib/pricing) and built by the booking code
// (src/lib/booking), the same path as the wizard, then create_order + the payment functions.
// ---------------------------------------------------------------------------
export async function privateCustomer({ email, firstName, lastName, phone }) {
  const c = await user(email, { first_name: firstName, last_name: lastName });
  const settings = await ok(service.from("settings").select("terms_version, privacy_version").single());
  if (c.created) await ok(service.from("customers").insert({ profile_id: c.id, customer_type: "private" }));
  const now = new Date().toISOString();
  await ok(service.from("profiles").update({
    first_name: firstName, last_name: lastName, phone,
    terms_accepted_at: now, terms_version: settings.terms_version, privacy_accepted_at: now, privacy_version: settings.privacy_version,
  }).eq("id", c.id));
  return c;
}

const PLACES = {
  milanoCentro: { address: "Via Dante 12, 20121 Milano MI", placeId: "demo-milano-dante", lat: 45.4668, lng: 9.1856, city: "Milano", postalCode: "20121", province: "MI" },
  milanoNavigli: { address: "Ripa di Porta Ticinese 55, 20143 Milano MI", placeId: "demo-milano-navigli", lat: 45.4516, lng: 9.1693, city: "Milano", postalCode: "20143", province: "MI" },
  monza: { address: "Via Italia 30, 20900 Monza MB", placeId: "demo-monza", lat: 45.5845, lng: 9.2744, city: "Monza", postalCode: "20900", province: "MB" },
  bergamo: { address: "Via XX Settembre 40, 24122 Bergamo BG", placeId: "demo-bergamo", lat: 45.6947, lng: 9.6693, city: "Bergamo", postalCode: "24122", province: "BG" },
  torino: { address: "Via Garibaldi 20, 10122 Torino TO", placeId: "demo-torino", lat: 45.0737, lng: 7.6806, city: "Torino", postalCode: "10122", province: "TO" },
  como: { address: "Via Vittorio Emanuele II 50, 22100 Como CO", placeId: "demo-como", lat: 45.8112, lng: 9.0853, city: "Como", postalCode: "22100", province: "CO" },
  brescia: { address: "Corso Zanardelli 10, 25121 Brescia BS", placeId: "demo-brescia", lat: 45.5389, lng: 10.2203, city: "Brescia", postalCode: "25121", province: "BS" },
  novara: { address: "Corso Italia 15, 28100 Novara NO", placeId: "demo-novara", lat: 45.4469, lng: 8.6219, city: "Novara", postalCode: "28100", province: "NO" },
};
// Road distances (km) — fixed, so the seed needs no Google Maps key.
const ROUTE_KM = {
  "milanoCentro-monza": 18, "milanoNavigli-bergamo": 52, "milanoCentro-torino": 143, "monza-como": 38, "bergamo-milanoNavigli": 52,
  "como-milanoCentro": 49, "milanoNavigli-milanoCentro": 4, "milanoCentro-brescia": 95, "monza-novara": 70, "bergamo-brescia": 55,
  "novara-milanoNavigli": 55, "como-bergamo": 60, "milanoNavigli-monza": 20, "brescia-milanoCentro": 95,
};
export const romeDate = (daysAhead) => new Date(Date.now() + daysAhead * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });

let booking;
async function loadBooking() {
  if (booking) return booking;
  const { createJiti } = require("jiti");
  const jiti = createJiti(import.meta.url, { alias: { "@": `${root}src`, "server-only": `${root}tests/stubs/server-only.ts` } });
  const { loadPricingConfig } = await jiti.import("@/lib/pricing/load");
  const { calculatePrice } = await jiti.import("@/lib/pricing/calculate");
  const { planLegs, priceInputFor } = await jiti.import("@/lib/booking/build");
  const { buildOrderPayload } = await jiti.import("@/lib/booking/order-payload");
  const { EMPTY_WIZARD_STATE } = await jiti.import("@/lib/booking/state");

  await ok(service.from("service_area_provinces").update({ is_active: true }).in("province_code", ["MI", "MB", "BG", "BS", "CO", "VA", "TO", "NO"]));
  let warehouse = (await ok(service.from("warehouses").select("id, address, city, province, lat, lng").eq("is_active", true).limit(1)))[0];
  if (!warehouse) {
    warehouse = await ok(service.from("warehouses").insert({ name: "Magazzino Transigo Milano", address: "Via Toffetti 20, 20139 Milano MI", city: "Milano", province: "MI", lat: 45.4398, lng: 9.2237, is_active: true }).select("id, address, city, province, lat, lng").single());
  }
  const settings = await ok(service.from("settings").select("terms_version, privacy_version").single());
  const config = await loadPricingConfig(service);
  booking = { calculatePrice, planLegs, priceInputFor, buildOrderPayload, EMPTY_WIZARD_STATE, warehouse, settings, config };
  return booking;
}

/** Creates an order (pending payment) for a private customer, priced like the wizard. */
export async function order(customer, { from, to, daysAhead, window = "10-12", vehicle = "van_medium", goods, packing = 0, storage = null, porters = null, portersDelivery = null, contacts, notes = "" }) {
  const b = await loadBooking();
  const vehicleId = await vehicleTypeId(vehicle);
  const A = { ...PLACES[from], warehouseId: null };
  const B = { ...PLACES[to], warehouseId: null };
  const E = b.EMPTY_WIZARD_STATE;
  const state = {
    ...E,
    pickup: { placeId: A.placeId, label: A.address, floor: goods.pickupFloor ?? 0, hasElevator: goods.pickupElevator ?? true },
    delivery: { placeId: B.placeId, label: B.address, floor: goods.deliveryFloor ?? 0, hasElevator: goods.deliveryElevator ?? true },
    pickupDate: romeDate(daysAhead),
    pickupWindow: window,
    goods: { ...E.goods, description: goods.description, itemsCount: goods.items ?? null, weightKg: goods.weightKg ?? null, largestItem: goods.largest ?? E.goods.largestItem, palletsCount: goods.pallets ?? null, loadCategory: porters ?? portersDelivery ?? null },
    portersPickup: porters ? { packageCode: porters } : null,
    portersDelivery: storage && portersDelivery ? { packageCode: portersDelivery } : null,
    packingItems: packing,
    storage: storage ? { returnDate: romeDate(daysAhead + storage.days), returnWindow: "14-16", pallets: storage.pallets } : null,
    vehicleTypeId: vehicleId,
  };
  const w = b.warehouse;
  const wh = { id: w.id, address: w.address, placeId: null, lat: w.lat, lng: w.lng, city: w.city, postalCode: null, province: w.province };
  const plan = b.planLegs(state, A, B, wh);
  if (!plan.ok) throw new Error(`plan: ${plan.error}`);
  const km = ROUTE_KM[`${from}-${to}`];
  if (!km) throw new Error(`no distance for ${from}-${to}`);
  const legs = plan.legs.map((l, i) => {
    const legKm = storage ? [12, km][i] : km;
    return { ...l, distanceM: legKm * 1000, durationS: Math.round(legKm * 75) };
  });
  const result = b.calculatePrice(b.priceInputFor({ state, legs, storageDays: plan.storageDays, storageBillingUnit: b.config.storageBillingUnit, vehicleTypeId: vehicleId, customerType: "private", now: new Date() }), b.config);
  if (!result.ok) throw new Error(`price (${goods.description}): ${JSON.stringify(result.error)}`);
  const at = new Date();
  const payload = b.buildOrderPayload({
    customerId: customer.id, state, vehicleTypeId: vehicleId, legs, storageDays: plan.storageDays, storageBillingUnit: b.config.storageBillingUnit,
    quote: result.quote, quotedAt: at, termsVersion: b.settings.terms_version, termsAcceptedAt: at,
    contacts: { pickupName: contacts[0], pickupPhone: "+393331234567", deliveryName: contacts[1], deliveryPhone: "+393337654321", notes },
    billingDetails: { customer_type: "private", fiscal_code: "CNTGLI85M41F205X", street: "Via Dante 12", city: "Milano", postal_code: "20121", province: "MI" },
  });
  const created = await ok(service.rpc("create_order", { p: payload }));
  return { id: created.id, number: created.order_number, total: result.quote.totalCents };
}

/** Pays the order the way the Stripe webhook does (start + confirm). */
export async function pay(o) {
  const session = `cs_test_demo_${randomUUID()}`;
  await ok(service.rpc("start_order_payment", { p_order_id: o.id, p_session_id: session, p_amount_cents: o.total, p_expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
  await ok(service.rpc("confirm_order_payment", { p_session_id: session, p_payment_intent_id: `pi_demo_${randomUUID()}`, p_charge_id: `ch_demo_${randomUUID()}`, p_amount_cents: o.total, p_currency: "eur" }));
  return o;
}

/** Orders of the customer for the end-of-run summary (number, status, goods, carrier). */
export async function printOrders(customerId) {
  const rows = await ok(service.from("orders")
    .select("order_number, status, goods_description, pickup_window_start, assigned_at, carriers:carrier_id(company_name), vehicle_types(name_it)")
    .eq("customer_id", customerId).order("order_number"));
  for (const r of rows) {
    const pickup = new Date(r.pickup_window_start).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" });
    console.log(`  ${r.order_number}  ${r.status.padEnd(15)} ${pickup.padEnd(17)} ${r.vehicle_types?.name_it?.padEnd(28) ?? ""} ${r.goods_description}${r.carriers ? `  → ${r.carriers.company_name}` : ""}`);
  }
}

export function printPasswordHint() {
  console.log(process.env.SEED_PASSWORD
    ? "\nPassword per tutti: quella di SEED_PASSWORD."
    : `\nPassword per tutti: nel file .seed-local/password (fuori dal repo) — cat .seed-local/password`);
}
