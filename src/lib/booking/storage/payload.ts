// Builds the create_service_order(jsonb) payload for a Deposito order and its chain (migrations three_services +
// storage_chain, D77, D153). Pure: every amount comes from the engine's quotes stored on the server, every place and
// route from the server (D76). The chain transports use the same builder as the transport wizard
// (buildOrderPayload), so their snapshot has exactly the transport shape; carrier amounts go only to their
// carrier_terms (assigned carrier + admin, D29).
import type { Quote } from "../../pricing/types";
import { buildOrderPayload } from "../order-payload";
import { EMPTY_WIZARD_STATE, type WizardState } from "../state";
import type { ResolvedLeg } from "../build";
import type { StoredChainTransport, StoredStorageInput } from "./server";
import type { TransportRole } from "./messages";

export type Contact = { name: string; phone: string };

const rehydrateLeg = (l: StoredChainTransport["leg"]): ResolvedLeg => ({ ...l, windowStart: new Date(l.windowStart), windowEnd: new Date(l.windowEnd) });

export type StoragePayloadArgs = {
  customerId: string;
  customerType: "private" | "business";
  input: StoredStorageInput; // the stored quote (state, period, warehouse, quotes)
  /** On-site contact of the transports (customer side); null when Transigo does no transport. */
  siteContact: Contact | null;
  /** Contact at the warehouse end of a transport (Transigo). */
  warehouseContact: Contact;
  notes: string;
  description: string; // the latest "Cosa depositi" the customer confirmed (not price-relevant)
  billingDetails: Record<string, unknown>;
  termsVersion: string;
  termsAcceptedAt: Date;
};

function charges(quote: Quote, a: StoragePayloadArgs, overtimeRate: number | null) {
  return {
    price_list_id: quote.priceListId,
    price_list_version: quote.priceListVersion,
    customer_type: quote.customerType,
    vat_rate_bp: quote.vatRateBp,
    subtotal_cents: quote.subtotalCents,
    vat_cents: quote.vatCents,
    total_cents: quote.totalCents,
    porter_overtime_rate_cents: overtimeRate,
    billing_details: a.billingDetails,
    terms_accepted_at: a.termsAcceptedAt.toISOString(),
    terms_version: a.termsVersion,
    quoted_at: a.input.now,
  };
}

/** One chain transport in the create_order shape (one leg to / from the warehouse). */
function transportPayload(role: TransportRole, t: StoredChainTransport, a: StoragePayloadArgs) {
  if (!a.siteContact) throw new Error("chain transport without an on-site contact");
  const s = a.input.state;
  const state: WizardState = {
    ...EMPTY_WIZARD_STATE,
    customerTypeView: a.customerType,
    goods: {
      description: a.description,
      itemsCount: s.goods.itemsCount,
      weightKg: s.goods.weightKg,
      dimensionsNote: "",
      loadCategory: s.goods.loadCategory,
      largestItem: s.goods.largestItem,
      palletsCount: a.customerType === "business" ? s.pallets : null,
      // D176: a company stores pallets; a private customer's box has no category
      shipmentCategory: a.customerType === "business" ? "pallet" : null,
      stackable: false,
    },
    packingItems: 0,
    storage: null,
  };
  const [pickup, delivery] = role === "intake" ? [a.siteContact, a.warehouseContact] : [a.warehouseContact, a.siteContact];
  return buildOrderPayload({
    customerId: a.customerId,
    state,
    vehicleTypeId: t.vehicleTypeId,
    legs: [rehydrateLeg(t.leg)],
    storageDays: null,
    storageBillingUnit: "pallet_day", // unused without storage
    quote: t.quote,
    quotedAt: new Date(a.input.now),
    contacts: { pickupName: pickup.name, pickupPhone: pickup.phone, deliveryName: delivery.name, deliveryPhone: delivery.phone, notes: a.notes },
    billingDetails: a.billingDetails,
    termsVersion: a.termsVersion,
    termsAcceptedAt: a.termsAcceptedAt,
  });
}

export function buildStorageOrderPayload(a: StoragePayloadArgs) {
  const { input } = a;
  const s = input.state;
  const quote = input.storage;
  const box = a.customerType === "private";
  if (box ? !s.boxCode : !s.pallets) throw new Error("storage payload without its unit");
  if (!s.startDate || !s.endDate) throw new Error("storage payload without its period");
  const intake = input.transports.intake;
  const outbound = input.transports.outbound;
  if ((s.intake === "transigo") !== !!intake || (s.outbound === "transigo") !== !!outbound) throw new Error("storage payload: transports do not match the state");

  return {
    service_type: "storage" as const,
    customer_id: a.customerId,
    goods_description: a.description,
    customer_notes: a.notes.trim() || null,
    booking: {
      warehouse_id: input.warehouseId,
      unit: box ? ("box" as const) : ("pallet" as const),
      box_code: box ? s.boxCode : null,
      pallets: box ? null : s.pallets,
      start_date: s.startDate,
      end_date: s.endDate,
      payment_plan: "upfront" as const, // D155 monthly: step 10 (D172)
      intake: s.intake,
      outbound: s.outbound,
    },
    charges: charges(quote, a, null),
    lines: quote.lines.map((l, i) => ({
      sort_order: i,
      leg_index: l.legIndex,
      line_type: l.lineType,
      label_it: l.labelIt,
      quantity: l.quantity,
      unit_amount_cents: l.unitAmountCents,
      net_cents: l.netCents,
      vat_cents: l.vatCents,
      gross_cents: l.grossCents,
      carrier_share_group: l.carrierShareGroup,
    })),
    ...(intake ? { intake_transport: transportPayload("intake", intake, a) } : {}),
    ...(outbound ? { outbound_transport: transportPayload("outbound", outbound, a) } : {}),
  };
}

export type StorageOrderPayload = ReturnType<typeof buildStorageOrderPayload>;
