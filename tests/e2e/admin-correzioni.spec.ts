import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { login, mainButton, serviceClient } from "./helpers";

// The admin's corrections on a running job (plan docs/plany/realizacja-kursu.md, krok 6), on the demo seed's jobs
// of Ferri (scripts/seed-demo.mjs): «Annulla ultimo passo» on the job with only «Sono arrivato al ritiro», and
// «Consenti inizio anticipato» for leg 2 of the warehouse job, «Rimuovi padroncino» with the goods in the warehouse
// (D136: «Da gestire», never back to «paid»). The admin works on a desktop browser, the carrier on
// a phone (Pixel 7) in a second context. The reasons are internal: «Note interne» for the admin only.
// LOCAL database only (D64).

const service = serviceClient();

async function orderByGoods(goods: string): Promise<string> {
  const { data, error } = await service.from("orders").select("id").eq("goods_description", goods).single();
  if (error || !data) throw new Error(`demo order "${goods}" missing: ${error?.message}`);
  return data.id;
}

async function carrierPage(browser: Browser, jobPath: string): Promise<Page> {
  const ctx = await browser.newContext({ ...devices["Pixel 7"], locale: "it-IT", timezoneId: "Europe/Rome" });
  const page = await ctx.newPage();
  await login(page, jobPath);
  return page;
}

test.describe("Correzioni dell'admin sulla corsa", () => {
  test("«Annulla ultimo passo»: il padroncino rivede «Sono arrivato al ritiro»", async ({ page, browser }) => {
    const orderId = await orderByGoods("Cucina componibile smontata");
    const reason = "Arrivo registrato per errore (prova e2e).";

    await login(page, `/admin/ordini/${orderId}`, "admin@example.com");
    await expect(page.getByText("Passo da annullare:")).toContainText("Arrivato al ritiro");
    await page.getByLabel("Motivo (obbligatorio)").fill(reason);
    await page.getByRole("button", { name: "Annulla ultimo passo" }).click();

    // The step stays in the list as undone (struck through); the reason only in «Note interne».
    await expect(page.getByText(/— annullato .* da /)).toBeVisible();
    await expect(page.getByRole("button", { name: "Annulla ultimo passo" })).toHaveCount(0);
    const notes = page.locator("section", { has: page.getByRole("heading", { name: "Note interne" }) });
    await expect(notes.getByText(reason)).toBeVisible();
    await expect(notes.getByText("Passo annullato", { exact: false })).toBeVisible();

    const carrier = await carrierPage(browser, `/padroncino/le-mie-corse/${orderId}`);
    await expect(mainButton(carrier, "Sono arrivato al ritiro")).toBeEnabled();
    await expect(carrier.getByText(reason)).toHaveCount(0); // internal
    await carrier.context().close();

    const { data: steps } = await service.from("order_leg_steps").select("step, reverted_at").eq("order_id", orderId);
    expect(steps).toHaveLength(1);
    expect(steps![0].reverted_at).not.toBeNull();
  });

  test("«Consenti inizio anticipato»: il padroncino inizia la tratta 2 prima del giorno di ritiro", async ({ page, browser }) => {
    const orderId = await orderByGoods("Arredo ufficio: 2 scrivanie e 10 scatoloni");
    const jobPath = `/padroncino/le-mie-corse/${orderId}`;
    const reason = "Il cliente chiede la consegna anticipata (prova e2e).";

    // Before: «In magazzino», the next step waits for the pickup day of leg 2.
    const carrier = await carrierPage(browser, jobPath);
    await expect(carrier.getByText(/^In magazzino:/)).toBeVisible();
    await expect(mainButton(carrier, "Sono arrivato al magazzino")).toBeDisabled();
    await expect(carrier.getByText(/^Potrai iniziare da /)).toBeVisible();

    await login(page, `/admin/ordini/${orderId}`, "admin@example.com");
    await expect(page.getByRole("button", { name: "Annulla ultimo passo" })).toBeVisible(); // leg 1 unloaded
    const form = page.locator("form", { hasText: "Tratta 2: il padroncino potrà iniziare prima del giorno di ritiro" });
    await form.getByLabel("Motivo (obbligatorio)").fill(reason);
    await form.getByRole("button", { name: "Consenti inizio anticipato" }).click();
    await expect(page.getByText(/Inizio anticipato consentito \(tratta 2\) il /)).toBeVisible();
    await expect(page.getByRole("button", { name: "Consenti inizio anticipato" })).toHaveCount(0);
    const notes = page.locator("section", { has: page.getByRole("heading", { name: "Note interne" }) });
    await expect(notes.getByText(reason)).toBeVisible();

    await carrier.reload();
    await expect(carrier.getByText(/^Potrai iniziare da /)).toHaveCount(0);
    await mainButton(carrier, "Sono arrivato al magazzino").click();
    await expect(mainButton(carrier, "Carico completato")).toBeVisible();
    await carrier.context().close();
  });

  test("«Rimuovi padroncino» con la merce in magazzino: «Da gestire», nuovo padroncino ritira in magazzino (D136)", async ({ page, browser }) => {
    const orderId = await orderByGoods("Scaffalature metalliche e 6 scatoloni di archivio");

    await login(page, `/admin/ordini/${orderId}`, "admin@example.com");
    const removal = page.locator("form", { has: page.getByRole("button", { name: "Rimuovi padroncino" }) });
    await expect(removal.getByText(/La merce è in magazzino: l'ordine passa in «Da gestire»/)).toBeVisible();
    await removal.getByLabel("Motivo", { exact: true }).selectOption("padroncino_non_disponibile");
    await removal.getByRole("button", { name: "Rimuovi padroncino" }).click();

    await expect(page.getByRole("heading", { name: "Da gestire" })).toBeVisible();
    await expect(page.getByText("Da gestire: merce in magazzino, padroncino rimosso")).toBeVisible();
    const address = page.getByLabel("Dove si trova ora la merce (obbligatorio)");
    await expect(address).toHaveValue(/Via Toffetti 20/); // the warehouse = pickup of leg 2
    const galli = await page.locator("#handover-candidate option", { hasText: "Galli Logistica" }).first().getAttribute("value");
    await page.locator("#handover-candidate").selectOption(galli!);
    await page.getByLabel("Motivo (obbligatorio)").first().fill("Ferri non disponibile (prova e2e).");
    await page.getByRole("button", { name: "Assegna padroncino" }).click();
    await expect(page.getByRole("heading", { name: "Da gestire" })).toHaveCount(0);
    await expect(page.getByText("Galli Logistica Srl").first()).toBeVisible();

    // The database: status never went back, no history row the customer could see.
    const { data: o } = await service.from("orders").select("status, handover_required_at").eq("id", orderId).single();
    expect(o).toEqual({ status: "in_transit", handover_required_at: null });
    const { data: hist } = await service.from("order_status_history").select("to_status").eq("order_id", orderId).order("id");
    expect(hist!.map((h) => h.to_status)).toEqual(["pending_payment", "paid", "assigned", "picked_up", "in_transit"]); // nothing after «In viaggio»

    // Galli (phone) picks the goods up at the warehouse.
    const ctx = await browser.newContext({ ...devices["Pixel 7"], locale: "it-IT", timezoneId: "Europe/Rome" });
    const carrier = await ctx.newPage();
    await login(carrier, `/padroncino/le-mie-corse/${orderId}`, "padroncino2@example.com");
    await expect(carrier.getByText("Ritiro merce presso:")).toContainText("Via Toffetti 20");
    await ctx.close();
  });
});
