import { describe, expect, it } from "vitest";
import {
  checkDocumentExpiry,
  documentStatus,
  latestDocuments,
  type CarrierDocumentRow,
  DOCUMENT_MSG,
  documentStoragePath,
  documentUploadSchema,
  MAX_DOCUMENT_BYTES,
  parseDocumentStoragePath,
  resolveDocumentFile,
  romeToday,
} from "./documents";

const CARRIER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const FILE = "55555555-5555-4555-8555-555555555555";

describe("resolveDocumentFile (D98)", () => {
  it("accepts PDF and photos, with jpg as the path extension for JPEG", () => {
    expect(resolveDocumentFile({ name: "albo.pdf", type: "application/pdf", size: 1000 })).toEqual({ ok: true, mimeType: "application/pdf", ext: "pdf" });
    expect(resolveDocumentFile({ name: "foto.jpeg", type: "image/jpeg", size: 1000 })).toEqual({ ok: true, mimeType: "image/jpeg", ext: "jpg" });
    expect(resolveDocumentFile({ name: "IMG_1.HEIC", type: "image/heic", size: 1000 })).toMatchObject({ ok: true, ext: "heic" });
  });
  it("falls back to the extension when the phone sends no type", () => {
    expect(resolveDocumentFile({ name: "IMG_2.HEIC", type: "", size: 1000 })).toEqual({ ok: true, mimeType: "image/heic", ext: "heic" });
    expect(resolveDocumentFile({ name: "doc.pdf", type: "application/octet-stream", size: 1000 })).toMatchObject({ ok: true, ext: "pdf" });
    expect(resolveDocumentFile({ name: "noext", type: "", size: 1000 })).toEqual({ ok: false, error: DOCUMENT_MSG.type });
  });
  it("rejects other types, empty and too large files", () => {
    expect(resolveDocumentFile({ name: "a.exe", type: "application/x-msdownload", size: 1000 })).toEqual({ ok: false, error: DOCUMENT_MSG.type });
    expect(resolveDocumentFile({ name: "a.pdf.exe", type: "", size: 1000 })).toEqual({ ok: false, error: DOCUMENT_MSG.type });
    expect(resolveDocumentFile({ name: "a.pdf", type: "application/pdf", size: 0 })).toEqual({ ok: false, error: DOCUMENT_MSG.empty });
    expect(resolveDocumentFile({ name: "a.pdf", type: "application/pdf", size: MAX_DOCUMENT_BYTES })).toMatchObject({ ok: true });
    expect(resolveDocumentFile({ name: "a.pdf", type: "application/pdf", size: MAX_DOCUMENT_BYTES + 1 })).toEqual({ ok: false, error: DOCUMENT_MSG.tooLarge });
  });
});

describe("storage path", () => {
  it("builds and parses {carrier_id}/{uuid}.{ext}", () => {
    const path = documentStoragePath(CARRIER, FILE, "jpg");
    expect(path).toBe(`${CARRIER}/${FILE}.jpg`);
    expect(parseDocumentStoragePath(path, CARRIER)).toEqual({ fileName: `${FILE}.jpg`, ext: "jpg" });
  });
  it("refuses another carrier's folder, subfolders, other extensions and names", () => {
    expect(parseDocumentStoragePath(`${OTHER}/${FILE}.pdf`, CARRIER)).toBeNull();
    expect(parseDocumentStoragePath(`${CARRIER}/sub/${FILE}.pdf`, CARRIER)).toBeNull();
    expect(parseDocumentStoragePath(`${CARRIER}/${FILE}.jpeg`, CARRIER)).toBeNull();
    expect(parseDocumentStoragePath(`${CARRIER}/../${OTHER}/${FILE}.pdf`, CARRIER)).toBeNull();
    expect(parseDocumentStoragePath(`${CARRIER}/rca.pdf`, CARRIER)).toBeNull();
  });
});

describe("checkDocumentExpiry (D98, D99)", () => {
  const today = "2026-11-09";
  it("required date: present, valid and not in the past (today is fine)", () => {
    expect(checkDocumentExpiry("insurance_rca", "2027-03-31", today)).toEqual({ ok: true, expiresAt: "2027-03-31" });
    expect(checkDocumentExpiry("insurance_rca", today, today)).toEqual({ ok: true, expiresAt: today });
    expect(checkDocumentExpiry("insurance_rca", "2026-11-08", today)).toEqual({ ok: false, error: DOCUMENT_MSG.expired });
    expect(checkDocumentExpiry("vehicle_registration", "", today)).toEqual({ ok: false, error: DOCUMENT_MSG.dateRequired("Prossima revisione") });
    expect(checkDocumentExpiry("driving_license", "2027-02-30", today)).toEqual({ ok: false, error: DOCUMENT_MSG.dateInvalid });
    expect(checkDocumentExpiry("driving_license", "31/12/2027", today)).toEqual({ ok: false, error: DOCUMENT_MSG.dateInvalid });
  });
  it("Albo has no date", () => {
    expect(checkDocumentExpiry("transport_license", "", today)).toEqual({ ok: true, expiresAt: null });
    expect(checkDocumentExpiry("transport_license", "2030-01-01", today)).toEqual({ ok: false, error: DOCUMENT_MSG.dateNotAllowed });
  });
  it("today is the Italian date", () => {
    expect(romeToday(new Date("2026-11-09T23:30:00Z"))).toBe("2026-11-10");
  });
});

describe("documentUploadSchema", () => {
  const base = { storagePath: `${CARRIER}/${FILE}.pdf`, fileName: "rca.pdf" };
  it("vehicle documents need a vehicle, company documents must not have one", () => {
    expect(documentUploadSchema.safeParse({ ...base, docType: "insurance_rca" }).success).toBe(false);
    expect(documentUploadSchema.safeParse({ ...base, docType: "insurance_rca", vehicleId: FILE }).success).toBe(true);
    expect(documentUploadSchema.safeParse({ ...base, docType: "driving_license", vehicleId: FILE }).success).toBe(false);
    expect(documentUploadSchema.safeParse({ ...base, docType: "driving_license", vehicleId: "" }).success).toBe(true);
  });
  it("types no longer accepted are refused (identity_document, D97)", () => {
    expect(documentUploadSchema.safeParse({ ...base, docType: "identity_document" }).success).toBe(false);
  });
});

describe("documents shown to the carrier", () => {
  const row = (extra: Partial<CarrierDocumentRow>): CarrierDocumentRow => ({
    id: "1", doc_type: "insurance_rca", vehicle_id: "v1", expires_at: "2027-01-31", review_status: "pending", rejection_reason: null,
    file_name: "rca.pdf", mime_type: "application/pdf", storage_path: "x", created_at: "2026-11-01T10:00:00Z", ...extra,
  });
  it("keeps the newest upload per type and vehicle", () => {
    const m = latestDocuments([
      row({ id: "old" }),
      row({ id: "new", created_at: "2026-11-05T10:00:00Z" }),
      row({ id: "other-vehicle", vehicle_id: "v2" }),
      row({ id: "albo", doc_type: "transport_license", vehicle_id: null, expires_at: null }),
    ]);
    expect([...m.entries()].map(([k, v]) => [k, v.id])).toEqual([["v1:insurance_rca", "new"], ["v2:insurance_rca", "other-vehicle"], ["carrier:transport_license", "albo"]]);
  });
  it("status: in review, approved, rejected with reason, expired", () => {
    const today = "2026-11-09";
    expect(documentStatus(row({}), today)).toEqual({ label: "In verifica · valido fino al 31/01/2027", tone: "wait" });
    expect(documentStatus(row({ review_status: "approved", expires_at: null }), today)).toEqual({ label: "Approvato", tone: "ok" });
    expect(documentStatus(row({ review_status: "rejected", rejection_reason: "illeggibile" }), today).label).toBe("Rifiutato: illeggibile. Carica un nuovo documento.");
    expect(documentStatus(row({ review_status: "approved", expires_at: "2026-11-08" }), today)).toEqual({ label: "Scaduto il 08/11/2026. Carica un documento valido.", tone: "bad" });
    expect(documentStatus(row({ expires_at: today }), today).tone).toBe("wait");
  });
});
