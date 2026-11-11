import { describe, expect, it } from "vitest";
import { makeConfig, NOW, withRule } from "../../pricing/__fixtures__/config";
import { calculatePortersPrice, type PortersPriceInput } from "../../pricing/porters-service";
import type { PricingConfig } from "../../pricing/types";
import type { Endpoint } from "../build";
import { buildPortersOrderPayload } from "./payload";
import { EMPTY_PORTERS_STATE, type PortersState } from "./state";

// The create_service_order payload of a Facchinaggio order comes 1:1 from the engine (D76, D157, D159).

const PLACE: Endpoint = { address: "Via Roma 1, 20121 Milano MI", placeId: "place-abc", lat: 45.46, lng: 9.19, city: "Milano", postalCode: "20121", province: "MI", warehouseId: null };
const WEDNESDAY = { date: "2026-11-18", start: new Date("2026-11-18T09:00:00Z"), end: new Date("2026-11-18T11:00:00Z") };
const SATURDAY = { date: "2026-11-21", start: new Date("2026-11-21T09:00:00Z"), end: new Date("2026-11-21T11:00:00Z") };

const state = (patch: Partial<PortersState> = {}): PortersState => ({
  ...EMPTY_PORTERS_STATE,
  place: { placeId: "place-abcdefghij", label: "Via Roma 1, Milano", floor: 4, hasElevator: false },
  date: WEDNESDAY.date,
  window: "10-12",
  persons: 2,
  hours: 3,
  description: "Armadio",
  ...patch,
});

function build(s: PortersState, window = WEDNESDAY, config: PricingConfig = makeConfig(), now = NOW) {
  const input: PortersPriceInput = {
    customerType: "private", now, startAt: window.start, province: "MI",
    persons: s.persons, hours: s.hours, floor: s.place!.floor, hasElevator: s.place!.hasElevator,
  };
  const r = calculatePortersPrice(input, config);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const payload = buildPortersOrderPayload({
    customerId: "cust-1", state: s, place: PLACE, window, quote: r.quote, job: r.job, quotedAt: now,
    contacts: { siteName: "Mario Rossi", sitePhone: "+393331234567", notes: "  Citofono B  " },
    description: "  Armadio e 10 scatoloni ", billingDetails: { first_name: "Mario" }, termsVersion: "2026-11-01", termsAcceptedAt: now,
  });
  return { r, payload };
}

describe("buildPortersOrderPayload", () => {
  it("lines = engine lines (leg 0, porters group); charges = sums of the lines", () => {
    const { r, payload } = build(state());
    expect(payload.lines.map((l) => [l.line_type, l.quantity, l.unit_amount_cents, l.net_cents, l.vat_cents, l.leg_index, l.carrier_share_group])).toEqual(
      r.quote.lines.map((l) => [l.lineType, l.quantity, l.unitAmountCents, l.netCents, l.vatCents, 0, "porters"]),
    );
    expect(payload.lines.map((l) => l.line_type)).toEqual(["porters", "porters_floors"]);
    expect(payload.charges.subtotal_cents).toBe(payload.lines.reduce((s, l) => s + l.net_cents, 0));
    expect(payload.charges.vat_cents).toBe(payload.lines.reduce((s, l) => s + l.vat_cents, 0));
    expect(payload.charges).toMatchObject({ subtotal_cents: 22_000, vat_cents: 4_840, total_cents: 26_840, customer_type: "private" });
  });

  it("carrier amount only in porter_terms (the porters share, D29); never in charges", () => {
    const { r, payload } = build(state());
    expect(payload.porter_terms).toEqual({ carrier_amount_cents: r.quote.carrierAmountCents, porter_share_kind: "percent", porter_share_bp: 8000, porter_share_carrier_cents: null, porter_share_net_cents: null });
    expect(payload.porter_terms.carrier_amount_cents).toBe(17_600);
    expect(JSON.stringify(payload.charges)).not.toContain("17600");
  });

  it("job snapshot: place from the server, window, persons, requested vs billed hours (D157 minimum)", () => {
    const { payload } = build(state({ hours: 1 }));
    expect(payload.porter_job).toMatchObject({
      address: PLACE.address, place_id: "place-abc", city: "Milano", province: "MI", job_date: WEDNESDAY.date,
      window_start: WEDNESDAY.start.toISOString(), window_end: WEDNESDAY.end.toISOString(),
      floor: 4, has_elevator: false, persons: 2, requested_hours: 1, billed_hours: 2, is_urgent: false, overtime_grace_minutes: 15,
    });
    expect(payload.lines[0]).toMatchObject({ quantity: 4, label_it: "Facchinaggio: 2 persone × 2 h (minimo)" });
  });

  it("weekend and urgent surcharges (D159) are lines of the porters group, flagged on the job", () => {
    const config = withRule(withRule(makeConfig(), "surcharge_urgent", { isEnabled: true, kind: "percent", percentBp: 2000 }), "surcharge_weekend_holiday", { isEnabled: true, kind: "percent", percentBp: 1000 });
    const urgentNow = new Date(SATURDAY.start.getTime() - 30 * 3_600_000); // within urgentLeadHours, beyond the minimum lead
    const { payload } = build(state({ place: { placeId: "place-abcdefghij", label: "x", floor: 0, hasElevator: true } }), SATURDAY, { ...config, minBookingLeadHours: 24, urgentLeadHours: 48 }, urgentNow);
    expect(payload.lines.map((l) => [l.line_type, l.net_cents, l.carrier_share_group])).toEqual([
      ["porters", 18_000, "porters"],
      ["surcharge_urgent", 3_600, "porters"],
      ["surcharge_weekend_holiday", 1_800, "porters"],
    ]);
    expect(payload.porter_job.is_urgent).toBe(true);
  });

  it("contacts, trimmed notes and description, overtime rate and terms", () => {
    const { payload } = build(state());
    expect(payload).toMatchObject({
      service_type: "porters", customer_id: "cust-1", goods_description: "Armadio e 10 scatoloni", customer_notes: "Citofono B",
      site_contact_name: "Mario Rossi", site_contact_phone: "+393331234567",
    });
    expect(payload.charges.porter_overtime_rate_cents).not.toBeUndefined();
    expect(payload.charges).toMatchObject({ terms_version: "2026-11-01", billing_details: { first_name: "Mario" } });
  });

  it("refuses a state without a place or a place without a province", () => {
    const { r } = build(state());
    const base = { customerId: "c", window: WEDNESDAY, quote: r.quote, job: r.job, quotedAt: NOW, contacts: { siteName: "a", sitePhone: "b", notes: "" }, description: "x", billingDetails: {}, termsVersion: "v", termsAcceptedAt: NOW };
    expect(() => buildPortersOrderPayload({ ...base, state: state({ place: null }), place: PLACE })).toThrow(/place/);
    expect(() => buildPortersOrderPayload({ ...base, state: state(), place: { ...PLACE, province: null } })).toThrow(/province/);
  });
});
