import { describe, expect, it } from "vitest";
import {
  ADMIN_CARRIER_MSG,
  adminCarrierDbError,
  carrierAccountTab,
  decisionSchema,
  describeMissingForAdmin,
  parseAdminCarrierTab,
  suspensionSchema,
} from "./admin";

const ID = "66666666-6666-4666-8666-666666666666";
const V = "77777777-7777-4777-8777-777777777777";

describe("carrierAccountTab (D100)", () => {
  it("pending_review is split by submitted_at", () => {
    expect(carrierAccountTab("pending_review", "2026-11-09T10:00:00Z")).toBe("da-verificare");
    expect(carrierAccountTab("pending_review", null)).toBe("incompleti");
  });
  it("other states", () => {
    expect(carrierAccountTab("active", null)).toBe("attivi");
    expect(carrierAccountTab("suspended", null)).toBe("sospesi");
    expect(carrierAccountTab("rejected", null)).toBe("rifiutati");
  });
  it("unknown tab in the URL → Da verificare", () => {
    expect(parseAdminCarrierTab("veicoli")).toBe("veicoli");
    expect(parseAdminCarrierTab("x")).toBe("da-verificare");
    expect(parseAdminCarrierTab(undefined)).toBe("da-verificare");
  });
});

describe("decision and suspension forms", () => {
  it("reject and suspend require a trimmed reason of 1–1000 characters", () => {
    expect(decisionSchema.safeParse({ id: ID, decision: "approve" }).success).toBe(true);
    expect(decisionSchema.safeParse({ id: ID, decision: "reject", reason: "   " }).success).toBe(false);
    expect(decisionSchema.safeParse({ id: ID, decision: "reject", reason: "x".repeat(1001) }).success).toBe(false);
    expect(decisionSchema.safeParse({ id: ID, decision: "reject", reason: "  Albo mancante " }).data).toEqual({ id: ID, decision: "reject", reason: "Albo mancante" });
    expect(suspensionSchema.safeParse({ id: ID, decision: "suspend" }).success).toBe(false);
    expect(suspensionSchema.safeParse({ id: ID, decision: "reactivate" }).success).toBe(true);
  });
  it("the id must be a uuid; unknown decisions are refused", () => {
    expect(decisionSchema.safeParse({ id: "1", decision: "approve" }).success).toBe(false);
    expect(decisionSchema.safeParse({ id: ID, decision: "maybe" }).success).toBe(false);
  });
});

describe("describeMissingForAdmin", () => {
  it("labels with the vehicle plate", () => {
    expect(describeMissingForAdmin(["company", "vehicle", "document:driving_license", `vehicle_document:${V}:insurance_rca`], [{ id: V, plate: "AB123CD" }]))
      .toEqual(["Dati aziendali incompleti", "Nessun veicolo attivo", "Patente del titolare", "Assicurazione RCA (AB123CD)"]);
  });
});

describe("adminCarrierDbError", () => {
  it("incomplete with the missing items", () => {
    const e = { code: "23514", message: "decide_carrier_review: incomplete", details: "document:transport_license" };
    expect(adminCarrierDbError(e, "decide")).toBe(`${ADMIN_CARRIER_MSG.incomplete} Iscrizione all'Albo degli autotrasportatori.`);
  });
  it("vehicle documents missing", () => {
    const e = { code: "23514", message: "approve_carrier_vehicle: documents missing", details: `vehicle_document:${V}:insurance_rca` };
    expect(adminCarrierDbError(e, "vehicle", [{ id: V, plate: "AB123CD" }])).toBe(`${ADMIN_CARRIER_MSG.vehicleDocumentsMissing} Assicurazione RCA (AB123CD).`);
  });
  it("55000 depends on the action; Riattiva with pending documents", () => {
    expect(adminCarrierDbError({ code: "55000", message: "x" }, "decide")).toBe(ADMIN_CARRIER_MSG.notAwaitingReview);
    expect(adminCarrierDbError({ code: "55000", message: "x" }, "document")).toBe(ADMIN_CARRIER_MSG.alreadyReviewed);
    expect(adminCarrierDbError({ code: "55000", message: "x", details: "pending_documents" }, "reactivate")).toBe(ADMIN_CARRIER_MSG.pendingDocuments);
    expect(adminCarrierDbError({ code: "55000", message: "x" }, "reactivate")).toBe(ADMIN_CARRIER_MSG.notSuspended);
    expect(adminCarrierDbError({ code: "55000", message: "review_carrier_document: carrier is not active or suspended" }, "document")).toBe(ADMIN_CARRIER_MSG.notActiveOrSuspended);
  });
  it("not an admin, unknown errors", () => {
    expect(adminCarrierDbError({ code: "42501", message: "not an admin" }, "decide")).toBe(ADMIN_CARRIER_MSG.forbidden);
    expect(adminCarrierDbError(null, "decide")).toBe(ADMIN_CARRIER_MSG.generic);
  });
});
