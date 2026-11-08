import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { planLegs, priceInputFor, type Endpoint } from "@/lib/booking/build";
import { placeOrder, type PlaceOrderDeps } from "@/lib/booking/place-order";
import type { StoredQuoteInput } from "@/lib/booking/server";
import { EMPTY_WIZARD_STATE, priceRelevantKey, type WizardState } from "@/lib/booking/state";
import { romeToday } from "@/lib/booking/windows";
import { calculatePrice } from "@/lib/pricing/calculate";
import { loadPricingConfig } from "@/lib/pricing/load";
import type { PricingConfig } from "@/lib/pricing/types";
import { createUser, deleteCreatedUsers, service, type TestUser } from "./helpers";

// Order saving logic (placeOrder — the core of the submitBooking Server Action), called directly against the
// local database: an order must NOT be created for a blocked vehicle (D84), an expired quote (D76) or a quote
// of another account (D76), and the customer gets an Italian message. Google is replaced by a stub.

const A: Endpoint = { address: "Via Torino 10, Milano", placeId: "place-a", lat: 45.46, lng: 9.19, city: "Milano", postalCode: "20123", province: "MI", warehouseId: null };
const B: Endpoint = { address: "Via Garibaldi 20, Torino", placeId: "place-b", lat: 45.07, lng: 7.68, city: "Torino", postalCode: "10122", province: "TO", warehouseId: null };

const NOW = new Date();
const PICKUP_DATE = romeToday(new Date(NOW.getTime() + 14 * 86_400_000)); // well beyond the minimum lead time

let customer: TestUser;
let otherCustomer: TestUser;
let config: PricingConfig;
let vanSmallId: string;
let requoteCalls = 0;

const check = async (p: PromiseLike<{ error: unknown }>) => {
  const { error } = await p;
  if (error) throw error;
};

const state = (goods: Partial<WizardState["goods"]> = {}): WizardState => ({
  ...EMPTY_WIZARD_STATE,
  pickup: { placeId: "place-aaaaaaaaaa", label: "Via Torino 10, Milano", floor: 0, hasElevator: true },
  delivery: { placeId: "place-bbbbbbbbbb", label: "Via Garibaldi 20, Torino", floor: 0, hasElevator: true },
  pickupDate: PICKUP_DATE,
  pickupWindow: "10-12",
  vehicleTypeId: vanSmallId,
  goods: { ...EMPTY_WIZARD_STATE.goods, description: "Scatoloni", weightKg: 200, largestItem: { lengthCm: 120, widthCm: 60, heightCm: 60 }, ...goods },
});

/** Stores a quote for `owner` exactly like quoteBooking does (engine + resolved legs), without Google. */
async function storeQuote(owner: TestUser | null, s: WizardState, validUntil: Date) {
  const plan = planLegs(s, A, B, null);
  if (!plan.ok) throw new Error(plan.error);
  const legs = plan.legs.map((l) => ({ ...l, distanceM: 143_000, durationS: 5_400 }));
  const result = calculatePrice(
    priceInputFor({ state: s, legs, storageDays: null, storageBillingUnit: config.storageBillingUnit, vehicleTypeId: s.vehicleTypeId!, customerType: "private", now: NOW }),
    config,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const input: StoredQuoteInput = {
    key: priceRelevantKey(s),
    ownerId: owner?.id ?? null,
    state: s,
    vehicleTypeId: s.vehicleTypeId!,
    storageDays: null,
    storageBillingUnit: config.storageBillingUnit,
    legs: legs.map((l) => ({ ...l, windowStart: l.windowStart.toISOString(), windowEnd: l.windowEnd.toISOString() })),
    now: NOW.toISOString(),
  };
  const { data, error } = await service
    .from("quotes")
    // created 30 min before it expires, like quoteBooking (quote_valid_minutes = 30)
    .insert({ price_list_id: result.quote.priceListId, customer_type: "private", input, quote: result.quote, created_at: new Date(validUntil.getTime() - 30 * 60_000).toISOString(), valid_until: validUntil.toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  return { quoteId: data.id as string, totalCents: result.quote.totalCents, validUntil };
}

const deps = (): PlaceOrderDeps => ({
  db: service,
  now: NOW,
  // Stub of quoteBooking: a fresh quote for the customer (as after expiry), no Google calls.
  requote: async (_db, s, _type, _now, ownerId) => {
    requoteCalls++;
    const q = await storeQuote(ownerId === customer.id ? customer : ownerId === otherCustomer.id ? otherCustomer : null, s, new Date(NOW.getTime() + 30 * 60_000));
    const stored = await service.from("quotes").select("quote, input").eq("id", q.quoteId).single();
    return {
      outcome: { ok: true, distancesKm: [143], vehicles: [], fit: { recommended: null, byVehicle: {}, noneFits: null }, porters: [], selected: null },
      server: { quoteId: q.quoteId, validUntil: q.validUntil, quote: stored.data!.quote, input: stored.data!.input },
    };
  },
});

const request = (s: WizardState, quoteId: string, shownTotalCents: number) => ({
  state: s,
  quoteId,
  shownTotalCents,
  contacts: { pickupName: "Mario Rossi", pickupPhone: "333 123 4567", deliveryName: "Lucia Bianchi", deliveryPhone: "333 765 4321", notes: "" },
  billing: { fiscalCode: "RSSMRA80A01F205X", street: "Via Roma 1", city: "Milano", postalCode: "20121", province: "MI" },
  acceptTerms: true,
});

async function ordersOf(user: TestUser) {
  const { count, error } = await service.from("orders").select("id", { count: "exact", head: true }).eq("customer_id", user.id);
  if (error) throw error;
  return count ?? 0;
}

beforeAll(async () => {
  [customer, otherCustomer] = await Promise.all([
    createUser({ first_name: "Sara", last_name: "Prova" }),
    createUser({ first_name: "Altro", last_name: "Cliente" }),
  ]);
  await check(service.from("customers").insert([customer, otherCustomer].map((u) => ({ profile_id: u.id, customer_type: "private" }))));
  const loaded = await loadPricingConfig(service);
  // The quote is stored by the server after its own area check; here only the stored quote matters.
  config = { ...loaded, serviceAreaProvinces: ["MI", "TO"] };
  const { data, error } = await service.from("vehicle_types").select("id").eq("code", "van_small").single(); // 750 kg, 180 × 140 × 125 cm
  if (error) throw error;
  vanSmallId = data.id;
});

beforeEach(() => {
  requoteCalls = 0;
});

afterAll(async () => {
  for (const user of [customer, otherCustomer]) {
    if (user) await service.from("orders").delete().eq("customer_id", user.id);
  }
  await deleteCreatedUsers();
});

describe("placeOrder: control case", () => {
  it("a valid quote of the customer with a load that fits creates the order", async () => {
    const s = state();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() + 30 * 60_000));
    const before = await ordersOf(customer);

    const result = await placeOrder(deps(), { userId: customer.id, customerType: "private" }, request(s, q.quoteId, q.totalCents));

    expect(result).toMatchObject({ status: "created", orderNumber: expect.stringMatching(/^TG-\d{4}-\d{6}$/) });
    expect(await ordersOf(customer)).toBe(before + 1);
    expect(requoteCalls).toBe(0);
  });
});

describe("placeOrder: blocked vehicle (D84) — no order, Italian message", () => {
  // The quote was stored while the load still fitted (goods are not part of the price key), then the
  // customer changed the goods — e.g. by editing the request. The server must check the vehicle again.
  it("load too heavy for the vehicle (5000 kg on a 750 kg van)", async () => {
    const q = await storeQuote(customer, state(), new Date(NOW.getTime() + 30 * 60_000));
    const before = await ordersOf(customer);

    const result = await placeOrder(deps(), { userId: customer.id, customerType: "private" }, request(state({ weightKg: 5000 }), q.quoteId, q.totalCents));

    expect(result).toEqual({ status: "error", message: "Portata insufficiente: max 750 kg.", step: "veicolo" });
    expect(await ordersOf(customer)).toBe(before);
  });

  it("largest item too long for the cargo space (400 cm in 180 × 140 × 125 cm)", async () => {
    const q = await storeQuote(customer, state(), new Date(NOW.getTime() + 30 * 60_000));
    const before = await ordersOf(customer);

    const result = await placeOrder(
      deps(),
      { userId: customer.id, customerType: "private" },
      request(state({ largestItem: { lengthCm: 400, widthCm: 60, heightCm: 60 } }), q.quoteId, q.totalCents),
    );

    expect(result).toEqual({ status: "error", message: "L'oggetto più grande non entra nel vano (180 × 140 × 125 cm).", step: "veicolo" });
    expect(await ordersOf(customer)).toBe(before);
  });
});

describe("placeOrder: quote checks (D76) — no order, Italian message", () => {
  it("expired quote: the server re-quotes and asks to confirm again, even if the price is the same", async () => {
    const s = state();
    const q = await storeQuote(customer, s, new Date(NOW.getTime() - 60_000)); // expired a minute ago
    const before = await ordersOf(customer);

    const result = await placeOrder(deps(), { userId: customer.id, customerType: "private" }, request(s, q.quoteId, q.totalCents));

    expect(result).toMatchObject({
      status: "price_changed",
      message: "Il preventivo è scaduto: abbiamo ricalcolato il prezzo. Controlla l'importo e conferma di nuovo.",
      quote: { totalCents: q.totalCents },
    });
    if (result.status !== "price_changed") throw new Error("unreachable");
    expect(result.quoteId).not.toBe(q.quoteId); // a new quote, owned by the customer
    expect(requoteCalls).toBe(1);
    expect(await ordersOf(customer)).toBe(before);
    expect(JSON.stringify(result)).not.toMatch(/carrier/i); // the browser never gets carrier amounts

    // Confirming the refreshed quote then works.
    const again = await placeOrder(deps(), { userId: customer.id, customerType: "private" }, request(s, result.quoteId, result.quote.totalCents));
    expect(again.status).toBe("created");
    expect(await ordersOf(customer)).toBe(before + 1);
  });

  it("quoteId of another customer: refused, no order and no re-quote", async () => {
    const s = state();
    const foreign = await storeQuote(otherCustomer, s, new Date(NOW.getTime() + 30 * 60_000));
    const [beforeMine, beforeOther] = [await ordersOf(customer), await ordersOf(otherCustomer)];

    const result = await placeOrder(deps(), { userId: customer.id, customerType: "private" }, request(s, foreign.quoteId, foreign.totalCents));

    expect(result).toEqual({
      status: "error",
      message: "Questo preventivo non appartiene al tuo account. Ricalcola il prezzo e conferma di nuovo.",
      step: "preventivo",
    });
    expect(requoteCalls).toBe(0);
    expect(await ordersOf(customer)).toBe(beforeMine);
    expect(await ordersOf(otherCustomer)).toBe(beforeOther);
    // The other customer's quote is untouched and still usable by its owner.
    const { data } = await service.from("quotes").select("id").eq("id", foreign.quoteId);
    expect(data).toHaveLength(1);
  });

  it("anonymous quote (made before signing in): re-quoted for the customer and confirmed again, no order yet", async () => {
    const s = state();
    const anon = await storeQuote(null, s, new Date(NOW.getTime() + 30 * 60_000));
    const before = await ordersOf(customer);

    const result = await placeOrder(deps(), { userId: customer.id, customerType: "private" }, request(s, anon.quoteId, anon.totalCents));

    expect(result).toMatchObject({ status: "price_changed", message: "Il prezzo è stato aggiornato. Controlla il nuovo importo e conferma di nuovo." });
    expect(requoteCalls).toBe(1);
    expect(await ordersOf(customer)).toBe(before);
  });
});
