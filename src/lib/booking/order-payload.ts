// Builds the create_order(jsonb) payload (supabase/migrations/*_orders.sql, D77) from a server-side quote.
// Pure: every amount comes from the engine's Quote, every place/route from the server (never the browser).
import type { Quote, StorageBillingUnit } from "../pricing/types";
import type { ResolvedLeg } from "./build";
import { isStackableCategory, type WizardState } from "./state";

export type Contacts = {
  pickupName: string;
  pickupPhone: string;
  deliveryName: string;
  deliveryPhone: string;
  notes: string;
};

export type OrderPayloadArgs = {
  customerId: string;
  state: WizardState;
  vehicleTypeId: string;
  legs: ResolvedLeg[];
  storageDays: number | null;
  storageBillingUnit: StorageBillingUnit;
  quote: Quote;
  quotedAt: Date;
  contacts: Contacts;
  billingDetails: Record<string, unknown>;
  termsVersion: string;
  termsAcceptedAt: Date;
};

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export function buildOrderPayload(a: OrderPayloadArgs) {
  const { quote, state } = a;
  const warehouseId = a.legs[0]?.delivery.warehouseId ?? null;

  const legs = a.legs.map((l, i) => {
    const porters = quote.porters.find((p) => p.legIndex === i && p.side === "both") ?? null;
    const side = (s: "loading" | "unloading") => quote.porters.find((p) => p.legIndex === i && p.side === s) ?? null;
    const loading = side("loading");
    const unloading = side("unloading");
    const anyPorters = porters ?? loading ?? unloading;
    return {
      leg_index: i,
      pickup_address: l.pickup.address,
      pickup_place_id: l.pickup.placeId,
      pickup_lat: l.pickup.lat,
      pickup_lng: l.pickup.lng,
      pickup_city: l.pickup.city,
      pickup_postal_code: l.pickup.postalCode,
      pickup_province: l.pickup.province,
      pickup_warehouse_id: l.pickup.warehouseId,
      delivery_address: l.delivery.address,
      delivery_place_id: l.delivery.placeId,
      delivery_lat: l.delivery.lat,
      delivery_lng: l.delivery.lng,
      delivery_city: l.delivery.city,
      delivery_postal_code: l.delivery.postalCode,
      delivery_province: l.delivery.province,
      delivery_warehouse_id: l.delivery.warehouseId,
      distance_m: l.distanceM,
      duration_s: l.durationS,
      pickup_date: l.pickupDate,
      pickup_window_start: l.windowStart.toISOString(),
      pickup_window_end: l.windowEnd.toISOString(),
      pickup_floor: l.pickupFloor,
      pickup_has_elevator: l.pickupHasElevator,
      delivery_floor: l.deliveryFloor,
      delivery_has_elevator: l.deliveryHasElevator,
      is_urgent: quote.isUrgentByLeg[i] ?? false,
      // D74: porter terms of this leg (snapshot of Quote.porters[], D68)
      porter_package_code: porters?.packageCode ?? null,
      porters_count: porters?.persons ?? 0,
      porters_included_hours: porters?.includedHours ?? null,
      porter_overtime_grace_minutes: anyPorters ? anyPorters.overtimeGraceMinutes : null,
      // D182: help per side
      loading_porters: loading?.persons ?? 0,
      loading_hours: loading?.includedHours ?? null,
      unloading_porters: unloading?.persons ?? 0,
      unloading_hours: unloading?.includedHours ?? null,
    };
  });

  const carrierTerms = a.legs.map((_, i) => {
    const ofGroup = (group: string) => sum(quote.lines.filter((l) => l.legIndex === i && l.carrierShareGroup === group).map((l) => l.carrierAmountCents));
    const transport = ofGroup("transport");
    const porters = ofGroup("porters");
    const packing = ofGroup("packing");
    const share = quote.porters.find((p) => p.legIndex === i)?.carrierShare ?? null;
    return {
      leg_index: i,
      carrier_amount_cents: transport + porters + packing,
      transport_carrier_cents: transport,
      porters_carrier_cents: porters,
      packing_carrier_cents: packing,
      porter_share_kind: share?.kind ?? null,
      porter_share_bp: share?.kind === "percent" ? share.percentBp : null,
      porter_share_carrier_cents: share?.kind === "ratio" ? share.carrierCents : null,
      porter_share_net_cents: share?.kind === "ratio" ? share.netCents : null,
    };
  });

  // One overtime rate per order: it comes from the price list, the same for every leg (D68, D77).
  const overtimeRate = quote.porters.find((p) => p.overtimeRatePerPersonCents !== null)?.overtimeRatePerPersonCents ?? null;

  return {
    customer_id: a.customerId,
    vehicle_type_id: a.vehicleTypeId,
    goods_description: state.goods.description.trim(),
    items_count: state.goods.itemsCount,
    weight_kg: state.goods.weightKg,
    goods_dimensions_note: state.goods.dimensionsNote.trim() || null,
    largest_item_length_cm: state.goods.largestItem.lengthCm,
    largest_item_width_cm: state.goods.largestItem.widthCm,
    largest_item_height_cm: state.goods.largestItem.heightCm,
    pallets_count: state.goods.palletsCount,
    load_category: state.goods.loadCategory,
    shipment_category: state.goods.shipmentCategory,
    stackable: isStackableCategory(state.goods.shipmentCategory) ? state.goods.stackable : null,
    packing_items_count: state.packingItems,
    pickup_contact_name: a.contacts.pickupName,
    pickup_contact_phone: a.contacts.pickupPhone,
    delivery_contact_name: a.contacts.deliveryName,
    delivery_contact_phone: a.contacts.deliveryPhone,
    customer_notes: a.contacts.notes.trim() || null,
    storage:
      state.storage && quote.storageType && warehouseId
        ? {
            storage_type: quote.storageType,
            storage_billing_unit: a.storageBillingUnit,
            storage_days: a.storageDays,
            storage_pallets: a.storageBillingUnit === "pallet_day" ? state.storage.pallets : null,
            warehouse_id: warehouseId,
          }
        : null,
    legs,
    charges: {
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
      quoted_at: a.quotedAt.toISOString(),
    },
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
    carrier_terms: carrierTerms,
  };
}

export type OrderPayload = ReturnType<typeof buildOrderPayload>;
