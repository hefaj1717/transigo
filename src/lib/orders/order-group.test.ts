import { describe, expect, it } from "vitest";
import { chainParts, chainRows, groupFilter, groupRootId, groupTotalCents, mergeGroupForInvoice, orderGroup } from "./order-group";
import { renderOrderPaidEmail } from "../notifications/templates/order-paid";
import { renderOrderCancelledEmail } from "../notifications/templates/order-cancellation";

// Storage chain (D153): group order and roles, invoice lines of the whole group, chain rows in e-mails.

const at = (s: number) => new Date(Date.UTC(2026, 10, 12, 10, 0, s)).toISOString();
const row = (id: string, service_type: string, parent: string | null, s: number) => ({ id, order_number: `TG-${id}`, service_type, parent_order_id: parent, created_at: at(s) });

const legs = (from: string, to: string) => [{ leg_index: 0, pickup_city: from, delivery_city: to, pickup_window_start: "2026-11-20T09:00:00Z", pickup_window_end: "2026-11-20T11:00:00Z" }];
const booking = { start_date: "2026-11-20", end_date: "2026-12-31", unit: "box", box_code: "m", pallets: null };

describe("orderGroup", () => {
  it("root first, then the children in creation order; roles in a chain", () => {
    const g = orderGroup([row("c", "transport", "a", 3), row("b", "storage", "a", 2), row("a", "transport", null, 1)]);
    expect(g.root.id).toBe("a");
    expect(g.members.map((m) => [m.id, m.role])).toEqual([["a", "intake"], ["b", "storage"], ["c", "outbound"]]);
  });

  it("porto io: the storage order is the root; outbound after it", () => {
    const g = orderGroup([row("s", "storage", null, 1), row("o", "transport", "s", 2)]);
    expect(g.members.map((m) => m.role)).toEqual(["storage", "outbound"]);
  });

  it("a single order has no role; rows of different groups or without a root throw", () => {
    expect(orderGroup([row("x", "transport", null, 1)]).members[0].role).toBeNull();
    expect(orderGroup([row("s", "storage", null, 1)]).members[0].role).toBeNull();
    expect(() => orderGroup([row("b", "storage", "a", 1)])).toThrow(/root/);
    expect(() => orderGroup([row("a", "transport", null, 1), row("b", "storage", "z", 2)])).toThrow(/different groups/);
  });

  it("root id and the PostgREST filter", () => {
    expect(groupRootId({ id: "b", parent_order_id: "a" })).toBe("a");
    expect(groupRootId({ id: "a", parent_order_id: null })).toBe("a");
    expect(groupFilter("a")).toBe("id.eq.a,parent_order_id.eq.a");
  });
});

const charges = (net: number, vat: number) => ({ customer_type: "private" as const, vat_rate_bp: 2200, subtotal_cents: net, vat_cents: vat, total_cents: net + vat, billing_details: { first_name: "Mario" } });
const line = (sort: number, label: string, net: number, vat: number) => ({ sort_order: sort, label_it: label, quantity: 1, net_cents: net, vat_cents: vat, gross_cents: net + vat });

describe("mergeGroupForInvoice", () => {
  it("sums the charges exactly and labels the lines per order, in chain order", () => {
    const m = mergeGroupForInvoice([
      { role: "intake", order_charges: charges(10_000, 2_200), order_lines: [line(1, "Supplemento", 1_000, 220), line(0, "Trasporto", 9_000, 1_980)] },
      { role: "storage", order_charges: charges(6_000, 1_320), order_lines: [line(0, "Box M × 42 giorni", 6_000, 1_320)] },
      { role: "outbound", order_charges: charges(10_000, 2_200), order_lines: [line(0, "Trasporto", 10_000, 2_200)] },
    ]);
    expect(m.charges).toEqual({ ...charges(26_000, 5_720), total_cents: 31_720 });
    expect(m.lines.map((l) => [l.sort_order, l.label_it])).toEqual([
      [0, "Ritiro e trasporto al deposito – Trasporto"],
      [1, "Ritiro e trasporto al deposito – Supplemento"],
      [1000, "Deposito – Box M × 42 giorni"],
      [2000, "Consegna dal deposito – Trasporto"],
    ]);
    expect(m.lines.reduce((s, l) => s + l.net_cents, 0)).toBe(m.charges.subtotal_cents);
  });

  it("a single order keeps its labels and amounts", () => {
    const m = mergeGroupForInvoice([{ role: null, order_charges: charges(6_000, 1_320), order_lines: [line(0, "Box M", 6_000, 1_320)] }]);
    expect(m).toEqual({ charges: charges(6_000, 1_320), lines: [line(0, "Box M", 6_000, 1_320)] });
  });

  it("group total", () => {
    expect(groupTotalCents([{ order_charges: { total_cents: 12_200 } }, { order_charges: { total_cents: 7_320 } }])).toBe(19_520);
    expect(() => groupTotalCents([{ order_charges: null }])).toThrow();
  });
});

describe("chain in e-mails", () => {
  const g = orderGroup([
    { ...row("a", "transport", null, 1), order_legs: legs("Firenze", "Prato") },
    { ...row("b", "storage", "a", 2), warehouse_bookings: booking },
    { ...row("c", "transport", "a", 3), order_legs: legs("Prato", "Pisa") },
  ]);
  const parts = chainParts(g.members)!;

  it("one row per order", () => {
    expect(chainRows(parts).map(([k, v]) => [k, v.split(",")[0]])).toEqual([
      ["Ritiro e trasporto al deposito", "Firenze → Prato"],
      ["Deposito", "Deposito Box M dal 20/11/2026 al 31/12/2026"],
      ["Consegna dal deposito", "Prato → Pisa"],
    ]);
    expect(chainParts([g.members[0]])).toBeUndefined();
  });

  it("order_paid: the chain, the group total, the next step is the pickup", () => {
    const e = renderOrderPaidEmail({ firstName: "Mario", orderNumber: "TG-a", summary: parts[0].summary, chain: parts, totalCents: 31_720, customerType: "private", orderUrl: "https://x/cliente/ordini/a" });
    expect(e.text).toContain("Ritiro e trasporto al deposito: Firenze → Prato");
    expect(e.text).toContain("Consegna dal deposito: Prato → Pisa");
    expect(e.text).toMatch(/Totale pagato: 317,20/);
    expect(e.text).toContain("preso in carico il ritiro della merce");
  });

  it("order_paid, porto io: the warehouse address and where to bring the goods", () => {
    const e = renderOrderPaidEmail({ firstName: null, orderNumber: "TG-b", summary: parts[1].summary, warehouse: { name: "Magazzino Prato", address: "Via Roma 1, Prato" }, totalCents: 7_320, customerType: "private", orderUrl: "https://x" });
    expect(e.text).toContain("Magazzino: Magazzino Prato, Via Roma 1, Prato");
    expect(e.text).toContain("Puoi portare la merce in magazzino");
  });

  it("order_cancelled: the whole chain", () => {
    const e = renderOrderCancelledEmail({ firstName: "Mario", orderNumber: "TG-a", summary: parts[0].summary, chain: parts, feeCents: 0, refundCents: 31_720, orderUrl: "https://x" });
    expect(e.text).toContain("insieme a tutti i servizi collegati");
    expect(e.text).toContain("Deposito: Deposito Box M");
  });
});
