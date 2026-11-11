// One-off DEMO invoices for orders paid before the invoices step (D149; plan docs/plany/faktury.md, section 5).
//
//   node scripts/einvoice-backfill.mjs                       local database, DRY RUN (lists, writes nothing)
//   node scripts/einvoice-backfill.mjs --apply               local database, issues the documents
//   node scripts/einvoice-backfill.mjs --staging=bacabuzzevwwdxrswbnc [--apply]
//                                                            staging — --apply ONLY with the owner's consent in that
//                                                            conversation (CLAUDE.md)
//
// Guards: dry run unless --apply; local = this repo's stack (127.0.0.1:55321 from `supabase status`); staging = the
// exact ref above AND .env.local pointing at it; any other project (production) is refused; refused unless the
// provider is DEMO (EINVOICE_PROVIDER unset or "demo") and outside production (VERCEL_ENV / SITE_INDEXING).
// Uses the same code as the app: queue_invoice → DEMO adapter → record_invoice_result, then the credit notes of
// succeeded refunds (src/lib/einvoice/flow.ts). No e-mails: old documents are not announced to customers.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const STAGING_REF = "bacabuzzevwwdxrswbnc";

function refuse(message) {
  console.error(`Rifiuto: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const known = new Set(["--apply", "--dry-run", `--staging=${STAGING_REF}`]);
for (const a of args) if (!known.has(a)) refuse(`argomento sconosciuto ${a} (ammessi: --apply, --dry-run, --staging=${STAGING_REF}).`);
if (args.includes("--apply") && args.includes("--dry-run")) refuse("--apply e --dry-run insieme.");
const APPLY = args.includes("--apply");
const STAGING = args.includes(`--staging=${STAGING_REF}`);

// ---------------------------------------------------------------------------
// Provider and production guards (also checked again by the DEMO adapter itself)
// ---------------------------------------------------------------------------
let fileEnv = {};
try {
  fileEnv = parseEnv(readFileSync(`${root}.env.local`, "utf8"));
} catch {
  if (STAGING) refuse(".env.local non trovato (le chiavi dello staging si leggono solo da lì).");
}
const provider = (process.env.EINVOICE_PROVIDER ?? fileEnv.EINVOICE_PROVIDER ?? "").trim() || "demo";
if (provider !== "demo") refuse(`EINVOICE_PROVIDER=${provider}: lo script emette solo documenti DEMO.`);
for (const env of [process.env, fileEnv]) {
  if (env.VERCEL_ENV === "production" || env.SITE_INDEXING === "on") refuse("ambiente di produzione (VERCEL_ENV=production o SITE_INDEXING=on).");
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------
let url, serviceKey;
if (STAGING) {
  if (fileEnv.NEXT_PUBLIC_SUPABASE_URL !== `https://${STAGING_REF}.supabase.co`) {
    refuse(`.env.local punta a ${fileEnv.NEXT_PUBLIC_SUPABASE_URL}, non allo staging ${STAGING_REF}.`);
  }
  if (!fileEnv.SUPABASE_SERVICE_ROLE_KEY) refuse(".env.local senza SUPABASE_SERVICE_ROLE_KEY.");
  url = fileEnv.NEXT_PUBLIC_SUPABASE_URL;
  serviceKey = fileEnv.SUPABASE_SERVICE_ROLE_KEY;
  console.log(`Destinazione: STAGING — progetto ${STAGING_REF} (${url}).`);
} else {
  for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) {
    const v = process.env[key];
    if (v && v !== "http://127.0.0.1:55321" && v !== "http://localhost:55321") refuse(`${key}=${v} non è il Supabase locale di questo repo.`);
  }
  let status;
  try {
    status = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    refuse("Supabase locale non avviato (npm run db:local:start).");
  }
  const api = new URL(status.API_URL);
  if (api.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(api.hostname) || api.port !== "55321") {
    refuse(`${status.API_URL} non è il Supabase locale di questo repo (127.0.0.1:55321).`);
  }
  url = status.API_URL;
  serviceKey = status.SERVICE_ROLE_KEY;
  console.log(`Destinazione: database LOCALE (${url}).`);
}
console.log(APPLY ? "Modalità: --apply (scrive)." : "Modalità: dry run (nessuna scrittura; per emettere aggiungi --apply).");

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const ok = async (p, what) => {
  const r = await p;
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

// ---------------------------------------------------------------------------
// What is missing (the same rule as the app: src/lib/einvoice/trigger.ts)
// ---------------------------------------------------------------------------
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@": `${root}src`, "server-only": `${root}tests/stubs/server-only.ts` } });
const { invoiceDueFor } = await jiti.import("@/lib/einvoice/trigger");

async function missing() {
  const pays = await ok(
    db.from("payments").select("id, purpose, status, review_reason, review_outcome, orders!inner(order_number, status), invoices(id)")
      .eq("status", "succeeded").is("invoices", null).order("paid_at").limit(1000),
    "payments",
  );
  const due = pays.filter((p) => invoiceDueFor(p, { status: p.orders.status }));
  const refunds = await ok(
    db.from("refunds").select("id, payment_id, amount_cents, orders!inner(order_number), invoices(id)").eq("status", "succeeded").is("invoices", null).limit(1000),
    "refunds",
  );
  // Notes only for payments that have (or are about to get) an invoice.
  const withInvoice = new Set((await ok(db.from("invoices").select("payment_id").eq("kind", "invoice"), "invoices")).map((r) => r.payment_id));
  const dueIds = new Set(due.map((p) => p.id));
  const notes = refunds.filter((r) => withInvoice.has(r.payment_id) || dueIds.has(r.payment_id));
  return { due, notes, skippedRefunds: refunds.length - notes.length };
}

const before = await missing();
console.log(`\nPagamenti senza fattura: ${before.due.length}`);
for (const p of before.due) console.log(`  ${p.orders.order_number}  pagamento ${p.id}`);
console.log(`Rimborsi riusciti senza nota di credito: ${before.notes.length}`);
for (const r of before.notes) console.log(`  ${r.orders.order_number}  rimborso ${r.id}  ${(r.amount_cents / 100).toFixed(2)} €`);
if (before.skippedRefunds) console.log(`(${before.skippedRefunds} rimborsi di pagamenti senza fattura — es. pagamenti doppi — restano senza nota)`);

if (!APPLY) {
  console.log("\nDry run: nulla è stato scritto.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Apply — the app's flow with the DEMO adapter
// ---------------------------------------------------------------------------
const { getEInvoiceProvider } = await jiti.import("@/lib/einvoice/index");
const { einvoiceDeps } = await jiti.import("@/lib/einvoice/server");
const { invoicePayment, creditNoteForRefund } = await jiti.import("@/lib/einvoice/flow");

const deps = { ...einvoiceDeps(db, getEInvoiceProvider(db, { EINVOICE_PROVIDER: "demo" }), "http://localhost"), notifyIssued: async () => {} };
const tally = { issued: 0, already_issued: 0, failed: 0, not_due: 0, waiting: 0 };
for (const p of before.due) {
  const outcome = await invoicePayment(deps, p.id);
  tally[outcome]++;
  console.log(`  fattura ${p.orders.order_number}: ${outcome}`);
}
// Notes are issued right after their invoice (flow.ts); anything left (e.g. invoices issued earlier) goes here.
const after = await missing();
for (const r of after.notes) {
  const outcome = await creditNoteForRefund(deps, r.id);
  tally[outcome]++;
  console.log(`  nota ${r.orders.order_number}: ${outcome}`);
}
const final = await missing();
console.log(`\nFatto: ${JSON.stringify(tally)}. Ancora mancanti: ${final.due.length} fatture, ${final.notes.length} note.`);
const { count: failed } = await db.from("invoices").select("id", { count: "exact", head: true }).eq("status", "failed");
if (failed) console.log("Documenti in errore: vedi /admin/fatture («Riprova»).");
