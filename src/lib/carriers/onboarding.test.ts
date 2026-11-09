import { describe, expect, it } from "vitest";
import {
  canEditOnboarding,
  canEditVehicles,
  carrierOnboarding,
  carrierOnboardingView,
  describeMissing,
  incompleteCodes,
  onboardingEditBlock,
  ONBOARDING_MSG,
  parseMissingCode,
  type CarrierOnboardingInput,
  vehicleEditBlock,
} from "./onboarding";

const V1 = "11111111-1111-4111-8111-111111111111";

describe("carrierOnboardingView (D100, D109)", () => {
  it("maps status and submitted_at to the screen", () => {
    expect(carrierOnboardingView("pending_review", null)).toBe("incomplete");
    expect(carrierOnboardingView("pending_review", "2026-11-09T10:00:00Z")).toBe("in_review");
    expect(carrierOnboardingView("rejected", null)).toBe("rejected");
    expect(carrierOnboardingView("active", "2026-11-09T10:00:00Z")).toBe("active");
    expect(carrierOnboardingView("suspended", null)).toBe("suspended");
    expect(carrierOnboardingView(null, null)).toBe("missing");
  });
  it("editing only before sending and after a rejection", () => {
    expect(["incomplete", "rejected"].every((v) => canEditOnboarding(v as never))).toBe(true);
    for (const v of ["in_review", "active", "suspended", "missing"] as const) expect(canEditOnboarding(v)).toBe(false);
    expect(onboardingEditBlock("incomplete")).toBeNull();
    expect(onboardingEditBlock("in_review")).toBe(ONBOARDING_MSG.inReview);
    expect(onboardingEditBlock("active")).toBe(ONBOARDING_MSG.notEditable);
  });
  it("vehicles are also editable when active, not in review or suspended (D112)", () => {
    for (const v of ["incomplete", "rejected", "active"] as const) expect(canEditVehicles(v)).toBe(true);
    for (const v of ["in_review", "suspended", "missing"] as const) expect(canEditVehicles(v)).toBe(false);
    expect(vehicleEditBlock("in_review")).toBe(ONBOARDING_MSG.inReview);
    expect(vehicleEditBlock("suspended")).toBe(ONBOARDING_MSG.notEditable);
  });
});

describe("missing codes (D99)", () => {
  it("parses every code shape", () => {
    expect(parseMissingCode("company")).toEqual({ kind: "company" });
    expect(parseMissingCode("vehicle")).toEqual({ kind: "vehicle" });
    expect(parseMissingCode("document:driving_license")).toEqual({ kind: "document", docType: "driving_license" });
    expect(parseMissingCode(`vehicle_document:${V1}:insurance_rca`)).toEqual({ kind: "vehicle_document", vehicleId: V1, docType: "insurance_rca" });
    expect(parseMissingCode("document:passport")).toEqual({ kind: "unknown", code: "document:passport" });
    expect(parseMissingCode("something")).toEqual({ kind: "unknown", code: "something" });
  });
  it("describes them in Italian with a link to the right screen", () => {
    const items = describeMissing(
      ["company", "vehicle", "document:transport_license", `vehicle_document:${V1}:vehicle_registration`, "x"],
      [{ id: V1, plate: "AB123CD" }],
    );
    expect(items.map((i) => [i.label, i.href])).toEqual([
      ["Completa i dati aziendali", "/padroncino/dati-aziendali"],
      ["Aggiungi almeno un veicolo", "/padroncino/veicoli/nuovo"],
      ["Carica: Iscrizione all'Albo degli autotrasportatori", "/padroncino/documenti#transport_license"],
      ["Carica: Libretto di circolazione (veicolo AB123CD)", `/padroncino/veicoli/${V1}#vehicle_registration`],
      ["Completa la registrazione", "/padroncino"],
    ]);
  });
  it("a vehicle not in the list is described without the plate", () => {
    expect(describeMissing([`vehicle_document:${V1}:insurance_rca`], [])[0].label).toBe("Carica: Assicurazione RCA");
  });
  it("reads the codes from the submit error", () => {
    expect(incompleteCodes({ code: "23514", message: "submit_carrier_for_review: incomplete", details: "vehicle,document:driving_license" }))
      .toEqual(["vehicle", "document:driving_license"]);
    expect(incompleteCodes({ code: "23514", message: "other check", details: "x" })).toBeNull();
    expect(incompleteCodes({ code: "42501", message: "incomplete" })).toBeNull();
    expect(incompleteCodes(null)).toBeNull();
  });
});

describe("carrier onboarding checklist", () => {
  const base: CarrierOnboardingInput = {
    view: "incomplete",
    missing: [],
    statusReason: null,
    submittedAt: null,
    phoneVerified: false,
    stripePayoutsEnabled: false,
  };
  const done = (i: CarrierOnboardingInput) => Object.fromEntries(carrierOnboarding(i).items.map((x) => [x.key, x.done]));

  it("fresh registration: company done, vehicles and documents missing, cannot submit", () => {
    const input = { ...base, missing: ["vehicle", "document:transport_license", "document:driving_license"] };
    expect(done(input)).toEqual({ company: true, vehicle: false, documents: false, phone: false, payouts: false, approval: false });
    expect(carrierOnboarding(input).canSubmit).toBe(false);
    expect(carrierOnboarding(input).notice).toBeNull();
  });
  it("a missing vehicle document leaves the vehicle step open", () => {
    expect(done({ ...base, missing: [`vehicle_document:${V1}:insurance_rca`] }).vehicle).toBe(false);
  });
  it("complete: can submit even without phone and Stripe (D108)", () => {
    const c = carrierOnboarding(base);
    expect(c.canSubmit).toBe(true);
    expect(c.items.filter((i) => i.comingSoon).map((i) => i.key)).toEqual(["phone", "payouts"]);
  });
  it("after a rejection: the reason is shown and the account can be sent again", () => {
    const c = carrierOnboarding({ ...base, view: "rejected", statusReason: "Patente illeggibile" });
    expect(c.notice).toContain("Patente illeggibile");
    expect(c.notice).toContain("inviali di nuovo");
    expect(c.canSubmit).toBe(true);
  });
  it("in review: read only with the date of sending (Europe/Rome)", () => {
    const c = carrierOnboarding({ ...base, view: "in_review", submittedAt: "2026-11-09T23:30:00Z" });
    expect(c.canSubmit).toBe(false);
    expect(c.notice).toContain("10 novembre 2026");
  });
  it("suspended shows the reason, cannot submit; active completes the approval step", () => {
    expect(carrierOnboarding({ ...base, view: "suspended", statusReason: "Assicurazione scaduta" }).notice).toContain("Assicurazione scaduta");
    expect(carrierOnboarding({ ...base, view: "suspended" }).canSubmit).toBe(false);
    expect(done({ ...base, view: "active" }).approval).toBe(true);
  });
});
