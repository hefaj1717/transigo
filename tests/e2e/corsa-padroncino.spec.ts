import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { JOBS_FILE } from "./global-setup";
import { localSupabase } from "./local-supabase";

// The whole job in a phone view (iPhone 13 / WebKit, Pixel 7 / Chromium) — plan docs/plany/realizacja-kursu.md,
// krok 4. Ferri (demo seed) runs a job accepted by him with every leg today: steps, camera photos (file chooser),
// an upload that fails once and «Riprova», removing a photo, in-app confirmations, porter time before the
// signature, finger signature with «Cancella», «Conferma consegna». Then the database: delivered with POD,
// positions saved, exactly one order_delivered e-mail. LOCAL database only (D64).

const PHOTO = path.join(__dirname, "fixtures", "foto.jpg");
const sb = localSupabase();
const service = createClient(sb.url, sb.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

function password(): string {
  if (process.env.SEED_PASSWORD) return process.env.SEED_PASSWORD;
  const file = path.join(process.cwd(), ".seed-local", "password");
  if (!existsSync(file)) throw new Error("seed password missing (.seed-local/password or SEED_PASSWORD)");
  return readFileSync(file, "utf8").trim();
}

function jobs(project: string): { single: string; storage: string } {
  return JSON.parse(readFileSync(JOBS_FILE, "utf8"))[project];
}

async function login(page: Page, next: string) {
  await page.goto(`/accedi?next=${encodeURIComponent(next)}`);
  await page.getByLabel("E-mail").fill("padroncino@example.com");
  await page.getByLabel("Password").fill(password());
  await page.getByRole("button", { name: "Accedi" }).click();
  await page.waitForURL((u) => u.pathname === next);
}

/** The big button at the bottom (sticky bar). */
const mainButton = (page: Page, name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" });

async function takePhoto(page: Page, leg: number, kind: "pickup" | "delivery", expectedCount: number) {
  await page.getByTestId(`photo-input-${leg}-${kind}`).setInputFiles(PHOTO);
  await expect(page.getByText(`${expectedCount}/10`)).toBeVisible();
  await expect(page.getByRole("img", { name: "Foto salvata" })).toHaveCount(expectedCount);
}

/** One tap (no dialog) — the button must then show the next step. */
async function tap(page: Page, label: string | RegExp, next: string | RegExp) {
  await mainButton(page, label).click();
  await expect(mainButton(page, next).or(page.getByRole("link", { name: next }))).toBeVisible();
}

/** Irreversible step: in-app confirmation, never window.confirm(). */
async function confirmStep(page: Page, label: string, next: string | RegExp) {
  await mainButton(page, label).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Sì, confermo" }).click();
  await expect(dialog).toBeHidden();
  await expect(mainButton(page, next).or(page.getByRole("link", { name: next }))).toBeVisible();
}

async function sign(page: Page) {
  const pad = page.getByTestId("signature-pad");
  // Centre it: at the bottom of the screen the sticky action bar would cover it.
  await pad.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 30 + i * 18, box.y + 120 - Math.sin(i / 2) * 40, { steps: 2 });
  await page.mouse.up();
}

async function confirmDelivery(page: Page, recipient: string) {
  await page.getByRole("link", { name: "Conferma consegna" }).click();
  await expect(page.getByRole("heading", { name: "Conferma consegna" })).toBeVisible();
  await expect(page.getByText("Tempo di lavoro dei facchini da confermare")).toBeVisible();

  // Nothing filled in: name and signature are asked for, no request leaves.
  await mainButton(page, "Conferma consegna").click();
  await expect(page.getByText("Scrivi il nome di chi riceve la merce.")).toBeVisible();
  await expect(page.getByText("Chiedi al destinatario di firmare nel riquadro.")).toBeVisible();

  await page.getByLabel("Nome di chi riceve la merce").fill(recipient);
  await sign(page);
  await page.getByRole("button", { name: "Cancella" }).click();
  await expect(page.getByText("Firma qui con il dito")).toBeVisible();
  await sign(page);

  await mainButton(page, "Conferma consegna").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(recipient)).toBeVisible();
  await dialog.getByRole("button", { name: "Sì, consegna effettuata" }).click();
  await page.waitForURL(/esito=consegnata/);
  await expect(page.getByText("Consegna confermata. Grazie!")).toBeVisible();
  await expect(page.getByText(`Consegnata a ${recipient}`)).toBeVisible();
}

async function checkDatabase(orderId: string, recipient: string) {
  const { data: order } = await service.from("orders").select("status, delivered_without_pod").eq("id", orderId).single();
  expect(order).toEqual({ status: "delivered", delivered_without_pod: false });
  const { data: proof } = await service.from("delivery_proofs").select("recipient_name, lat").eq("order_id", orderId).single();
  expect(proof?.recipient_name).toBe(recipient);
  // One-time position: given by the browser on localhost (secure context); over http on the Wi-Fi address (E2E_HOST,
  // like a phone in variant A) the browser has no geolocation — the delivery goes through without it.
  if (!process.env.E2E_HOST) expect(proof?.lat).toBeCloseTo(45.4642, 3);
  else expect(proof?.lat).toBeNull();
  const { data: mails } = await service.from("email_outbox").select("id").eq("order_id", orderId).eq("template_code", "order_delivered");
  expect(mails).toHaveLength(1);
  const { data: legs } = await service.from("order_legs").select("porters_worked_minutes").eq("order_id", orderId);
  expect(legs?.every((l) => l.porters_worked_minutes !== null)).toBe(true);
}

test.describe("Corsa del padroncino sul telefono", () => {
  test("una tratta con facchini: dal ritiro alla consegna con firma", async ({ page }, info) => {
    const orderId = jobs(info.project.name).single;
    const jobPath = `/padroncino/le-mie-corse/${orderId}`;
    await login(page, jobPath);

    await expect(page.getByText("Contatto:")).toBeVisible();
    await expect(page.getByRole("link", { name: "Google Maps", exact: true })).toHaveAttribute("href", /google\.com\/maps\/dir/);
    await expect(page.getByRole("link", { name: "Apple Maps", exact: true })).toHaveAttribute("href", /maps\.apple\.com/);

    await tap(page, "Sono arrivato al ritiro", "Carico completato");
    await expect(mainButton(page, "Carico completato")).toBeDisabled();
    await expect(page.getByText("Aggiungi almeno una foto.")).toBeVisible();

    // Upload that fails once (network) → the photo stays with «Riprova».
    let failOnce = true;
    await page.route("**/storage/v1/object/upload/sign/**", (route) => {
      if (failOnce) {
        failOnce = false;
        return route.abort("internetdisconnected");
      }
      return route.continue();
    });
    await page.getByTestId("photo-input-0-pickup").setInputFiles(PHOTO);
    await expect(page.getByRole("alert").filter({ hasText: "Connessione assente" })).toBeVisible();
    await expect(mainButton(page, "Carico completato")).toBeDisabled();
    await page.getByRole("button", { name: "Riprova" }).click();
    await expect(page.getByText("1/10")).toBeVisible();
    await page.unroute("**/storage/v1/object/upload/sign/**");

    // A second photo, then remove one while the step is open.
    await takePhoto(page, 0, "pickup", 2);
    await page.getByRole("button", { name: "Elimina foto" }).first().click();
    await expect(page.getByText("1/10")).toBeVisible();

    await confirmStep(page, "Carico completato", "Inizia il viaggio");
    await tap(page, "Inizia il viaggio", "Sono arrivato alla consegna");
    await tap(page, "Sono arrivato alla consegna", "Scarico completato");
    await takePhoto(page, 0, "delivery", 1);
    await confirmStep(page, "Scarico completato", "Conferma consegna");
    await expect(page.getByText("Tempo di lavoro dei facchini")).toBeVisible();

    await confirmDelivery(page, "Paolo Prova");
    await checkDatabase(orderId, "Paolo Prova");
  });

  test("con magazzino: due tratte, «In magazzino», poi consegna", async ({ page }, info) => {
    const orderId = jobs(info.project.name).storage;
    await login(page, `/padroncino/le-mie-corse/${orderId}`);

    await tap(page, "Sono arrivato al ritiro", "Carico completato");
    await takePhoto(page, 0, "pickup", 1);
    await confirmStep(page, "Carico completato", "Inizia il viaggio");
    await tap(page, "Inizia il viaggio", "Sono arrivato al magazzino");
    await tap(page, "Sono arrivato al magazzino", "Scarico in magazzino completato");
    await takePhoto(page, 0, "delivery", 1);
    await confirmStep(page, "Scarico in magazzino completato", "Sono arrivato al magazzino");
    await expect(page.getByText(/^In magazzino:/)).toBeVisible();

    await tap(page, "Sono arrivato al magazzino", "Carico completato");
    await takePhoto(page, 1, "pickup", 1);
    await confirmStep(page, "Carico completato", "Inizia il viaggio");
    await tap(page, "Inizia il viaggio", "Sono arrivato alla consegna");
    await tap(page, "Sono arrivato alla consegna", "Scarico completato");
    await takePhoto(page, 1, "delivery", 1);
    await confirmStep(page, "Scarico completato", "Conferma consegna");

    await confirmDelivery(page, "Marta Prova");
    await checkDatabase(orderId, "Marta Prova");
  });
});
