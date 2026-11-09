// Test carriers for manual checks of /admin/padroncini — LOCAL Supabase only (D64), never staging/production.
// Usage: npm run db:local:start, then `node scripts/seed-local-carriers.mjs`. Keys come from `supabase status`
// (no secrets in files). Prints the admin login and one carrier per state. npm run test:rls resets the local
// database and removes these accounts — run this again afterwards.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");
const status = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const url = status.API_URL;
if (url !== "http://127.0.0.1:55321") throw new Error(`Refusing to seed ${url}: local Supabase only`);
const env = { anon: status.ANON_KEY, service: status.SERVICE_ROLE_KEY };
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(url, env.service, opts);
const ok = async (p) => { const r = await p; if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const PW = "Prova-12345!";
const FUTURE = "2099-12-31";
const vanId = (await ok(service.from("vehicle_types").select("id").eq("code", "van_medium").single())).id;
const pdf = new Blob(["%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"], { type: "application/pdf" });

async function user(email, meta) {
  const u = await ok(service.auth.admin.createUser({ email, password: PW, email_confirm: true, user_metadata: meta }));
  const c = createClient(url, env.anon, opts);
  await ok(c.auth.signInWithPassword({ email, password: PW }));
  return { id: u.user.id, client: c };
}
let n = 0;
const vat = () => `IT${String(10000000000 + Date.now() % 1e9 + ++n).slice(-11)}`;
async function carrier(name, email) {
  const u = await user(email, { role: "padroncino", first_name: "Mario", last_name: name });
  await ok(service.from("carriers").insert({ profile_id: u.id, company_name: `Trasporti ${name} Srl`, vat_number: vat(), fiscal_code: "RSSMRA80A01H501U", hq_street: "Via Roma 1", hq_city: "Milano", hq_postal_code: "20100", hq_province: "MI", sdi_code: "M5UXCR1" }));
  return u;
}
async function doc(c, docType, extra = {}) {
  const path = `${c.id}/${randomUUID()}.pdf`;
  await ok(c.client.storage.from("carrier-documents").upload(path, pdf, { contentType: "application/pdf" }));
  return (await ok(c.client.from("carrier_documents").insert({ carrier_id: c.id, doc_type: docType, storage_path: path, file_name: `${docType}.pdf`, mime_type: "application/pdf", size_bytes: 60, ...extra }).select("id").single())).id;
}
async function vehicle(c, plate, docs = true) {
  const v = await ok(c.client.from("carrier_vehicles").insert({ carrier_id: c.id, vehicle_type_id: vanId, plate, payload_kg: 1200 }).select("id").single());
  if (docs) { await doc(c, "vehicle_registration", { vehicle_id: v.id, expires_at: FUTURE }); await doc(c, "insurance_rca", { vehicle_id: v.id, expires_at: FUTURE }); }
  return v.id;
}
async function complete(name, email, plate) {
  const c = await carrier(name, email);
  await doc(c, "transport_license"); await doc(c, "driving_license", { expires_at: FUTURE });
  c.vehicleId = await vehicle(c, plate);
  return c;
}
const stamp = Date.now().toString(36).toUpperCase().slice(-4);
const admin = await user(`admin-${stamp}@example.com`, {});
await ok(service.from("profiles").update({ role: "admin" }).eq("id", admin.id));

const inReview = await complete("Verdi", `verdi-${stamp}@example.com`, `RV${stamp}A`);
await ok(inReview.client.rpc("submit_carrier_for_review"));

const active = await complete("Bianchi", `bianchi-${stamp}@example.com`, `BI${stamp}A`);
await ok(active.client.rpc("submit_carrier_for_review"));
await ok(service.rpc("decide_carrier_review", { p_carrier_id: active.id, p_admin_id: admin.id, p_approve: true, p_reason: null }));
await vehicle(active, `BI${stamp}B`);                                   // new vehicle
await ok(active.client.from("carrier_vehicles").update({ payload_kg: 1500 }).eq("id", active.vehicleId)); // re-verify
await doc(active, "goods_insurance", { expires_at: FUTURE });            // pending company doc

const suspended = await complete("Neri", `neri-${stamp}@example.com`, `NE${stamp}A`);
await ok(suspended.client.rpc("submit_carrier_for_review"));
await ok(service.rpc("decide_carrier_review", { p_carrier_id: suspended.id, p_admin_id: admin.id, p_approve: true, p_reason: null }));
await ok(service.rpc("set_carrier_suspension", { p_carrier_id: suspended.id, p_admin_id: admin.id, p_suspend: true, p_reason: "RCA scaduta: carica la nuova polizza." }));
await doc(suspended, "insurance_rca", { vehicle_id: suspended.vehicleId, expires_at: FUTURE });

const incomplete = await carrier("Gialli", `gialli-${stamp}@example.com`);
await doc(incomplete, "transport_license");

const rejected = await complete("Rosa", `rosa-${stamp}@example.com`, `RO${stamp}A`);
await ok(rejected.client.rpc("submit_carrier_for_review"));
await ok(service.rpc("decide_carrier_review", { p_carrier_id: rejected.id, p_admin_id: admin.id, p_approve: false, p_reason: "Albo non leggibile." }));

console.log(`Admin: admin-${stamp}@example.com / ${PW}`);
for (const [label, c, name] of [["In verifica", inReview, "Verdi"], ["Attivo", active, "Bianchi"], ["Sospeso", suspended, "Neri"], ["Incompleto", incomplete, "Gialli"], ["Rifiutato", rejected, "Rosa"]]) {
  console.log(`${label.padEnd(11)} Trasporti ${name} Srl  /admin/padroncini/${c.id}`);
}
console.log(`Targhe: ${["RV", "BI", "NE", "RO"].map((p) => `${p}${stamp}A`).join(", ")}, BI${stamp}B`);
