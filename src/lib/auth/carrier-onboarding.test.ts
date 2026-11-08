import { describe, expect, it } from "vitest";
import { carrierOnboarding, type CarrierOnboardingInput } from "./carrier-onboarding";

const company = {
  company_name: "Trasporti Rossi",
  vat_number: "00743110157",
  fiscal_code: "00743110157",
  hq_street: "Via Roma 1",
  hq_city: "Milano",
  hq_postal_code: "20121",
  hq_province: "MI",
  pec: "t@pec.it",
  sdi_code: null,
};

const base: CarrierOnboardingInput = {
  status: "pending_review",
  statusReason: null,
  company,
  phoneVerified: false,
  documentsCount: 0,
  activeVehiclesCount: 0,
  stripePayoutsEnabled: false,
};

const done = (i: CarrierOnboardingInput) =>
  Object.fromEntries(carrierOnboarding(i).items.map((x) => [x.key, x.done]));

describe("carrier onboarding checklist", () => {
  it("fresh registration: company data done, everything else missing", () => {
    expect(done(base)).toEqual({ company: true, phone: false, documents: false, vehicle: false, payouts: false, approval: false });
    expect(carrierOnboarding(base).notice).toBeNull();
  });
  it("company data is incomplete without HQ address or without SDI/PEC", () => {
    expect(done({ ...base, company: { ...company, hq_city: " " } }).company).toBe(false);
    expect(done({ ...base, company: { ...company, pec: null } }).company).toBe(false);
    expect(done({ ...base, company: null }).company).toBe(false);
  });
  it("Stage 4 steps are marked as coming soon", () => {
    const soon = carrierOnboarding(base).items.filter((i) => i.comingSoon).map((i) => i.key);
    expect(soon).toEqual(["phone", "documents", "vehicle", "payouts"]);
  });
  it("rejected and suspended show the admin's reason", () => {
    expect(carrierOnboarding({ ...base, status: "rejected", statusReason: "Licenza scaduta" }).notice).toContain("Licenza scaduta");
    expect(carrierOnboarding({ ...base, status: "suspended", statusReason: null }).notice).toContain("sospeso");
  });
});
