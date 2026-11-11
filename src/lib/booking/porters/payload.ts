// Builds the create_service_order(jsonb) payload for a Facchinaggio order (migration three_services, D77, D151).
// Pure: every amount comes from the engine's quote (calculatePortersPrice), the place from the server (D76).
// Carrier amounts go only to porter_terms (assigned carrier + admin, D29) — never to anything the customer reads.
import type { PortersJobTerms } from "../../pricing/porters-service";
import type { Quote } from "../../pricing/types";
import type { Endpoint } from "../build";
import type { PortersState } from "./state";

export type PortersPayloadArgs = {
  customerId: string;
  state: PortersState; // the state the quote was computed for
  place: Endpoint; // resolved by the server
  window: { date: string; start: Date; end: Date };
  quote: Quote;
  job: PortersJobTerms;
  quotedAt: Date;
  contacts: { siteName: string; sitePhone: string; notes: string };
  description: string; // the latest "Cosa spostare" the customer confirmed (not price-relevant)
  billingDetails: Record<string, unknown>;
  termsVersion: string;
  termsAcceptedAt: Date;
};

export function buildPortersOrderPayload(a: PortersPayloadArgs) {
  const { quote, job, state } = a;
  if (!state.place) throw new Error("porters payload without a place");
  if (!a.place.province) throw new Error("porters payload without a province");
  const share = job.carrierShare;
  return {
    service_type: "porters" as const,
    customer_id: a.customerId,
    goods_description: a.description.trim(),
    customer_notes: a.contacts.notes.trim() || null,
    site_contact_name: a.contacts.siteName,
    site_contact_phone: a.contacts.sitePhone,
    porter_job: {
      address: a.place.address,
      place_id: a.place.placeId,
      lat: a.place.lat,
      lng: a.place.lng,
      city: a.place.city,
      postal_code: a.place.postalCode,
      province: a.place.province,
      job_date: a.window.date,
      window_start: a.window.start.toISOString(),
      window_end: a.window.end.toISOString(),
      floor: state.place.floor,
      has_elevator: state.place.hasElevator,
      persons: job.persons,
      requested_hours: state.hours,
      billed_hours: job.includedHours, // max(requested, minimum of the price list) — computed by the engine
      is_urgent: quote.isUrgentByLeg[0] ?? false,
      overtime_grace_minutes: job.overtimeGraceMinutes,
    },
    charges: {
      price_list_id: quote.priceListId,
      price_list_version: quote.priceListVersion,
      customer_type: quote.customerType,
      vat_rate_bp: quote.vatRateBp,
      subtotal_cents: quote.subtotalCents,
      vat_cents: quote.vatCents,
      total_cents: quote.totalCents,
      porter_overtime_rate_cents: job.overtimeRatePerPersonCents,
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
    porter_terms: {
      carrier_amount_cents: quote.carrierAmountCents,
      porter_share_kind: share?.kind ?? null,
      porter_share_bp: share?.kind === "percent" ? share.percentBp : null,
      porter_share_carrier_cents: share?.kind === "ratio" ? share.carrierCents : null,
      porter_share_net_cents: share?.kind === "ratio" ? share.netCents : null,
    },
  };
}

export type PortersOrderPayload = ReturnType<typeof buildPortersOrderPayload>;
