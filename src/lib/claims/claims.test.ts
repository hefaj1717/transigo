import { describe, expect, it } from "vitest";
import {
  canOpenClaim,
  CLAIM_MSG,
  claimDeadline,
  claimErrorMessage,
  claimPhotoPath,
  claimUploadErrorMessage,
  isClaimPhotoPath,
  openClaimSchema,
} from "./claims";

const CLAIM = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";

describe("claim window (D138)", () => {
  const delivered = "2026-11-01T10:00:00Z";
  it("14 days after delivery, inclusive", () => {
    expect(claimDeadline(new Date(delivered)).toISOString()).toBe("2026-11-15T10:00:00.000Z");
    expect(canOpenClaim({ status: "delivered", delivered_at: delivered }, new Date("2026-11-15T10:00:00Z"))).toBe(true);
    expect(canOpenClaim({ status: "completed", delivered_at: delivered }, new Date("2026-11-15T10:00:01Z"))).toBe(false);
  });
  it("only delivered / completed orders with a delivery time", () => {
    for (const status of ["paid", "assigned", "in_transit", "cancelled"]) expect(canOpenClaim({ status, delivered_at: delivered }, new Date(delivered))).toBe(false);
    expect(canOpenClaim({ status: "delivered", delivered_at: null }, new Date(delivered))).toBe(false);
  });
});

describe("openClaimSchema", () => {
  it("trims the description and checks length and category", () => {
    expect(openClaimSchema.parse({ orderId: CLAIM, category: "delay", description: "  Arrivato con 3 ore di ritardo  " }).description).toBe("Arrivato con 3 ore di ritardo");
    expect(openClaimSchema.safeParse({ orderId: CLAIM, category: "delay", description: "corto" }).success).toBe(false);
    expect(openClaimSchema.safeParse({ orderId: CLAIM, category: "refund_now", description: "Descrizione lunga abbastanza" }).success).toBe(false);
    expect(openClaimSchema.safeParse({ orderId: "x", category: "delay", description: "Descrizione lunga abbastanza" }).success).toBe(false);
  });
});

describe("photo paths", () => {
  it("only {claim}/{uuid}.jpg of that claim", () => {
    expect(isClaimPhotoPath(CLAIM, claimPhotoPath(CLAIM, FILE))).toBe(true);
    expect(isClaimPhotoPath(CLAIM, `${FILE}/${FILE}.jpg`)).toBe(false);
    expect(isClaimPhotoPath(CLAIM, `${CLAIM}/${FILE}.png`)).toBe(false);
    expect(isClaimPhotoPath(CLAIM, `${CLAIM}/../${FILE}.jpg`)).toBe(false);
  });
});

describe("messages", () => {
  it("database errors", () => {
    expect(claimErrorMessage({ code: "55000", details: "too_late" })).toBe(CLAIM_MSG.tooLate);
    expect(claimErrorMessage({ code: "55000", details: "too_many_photos" })).toBe(CLAIM_MSG.tooManyPhotos);
    expect(claimErrorMessage({ code: "22023", details: "order" })).toBe(CLAIM_MSG.notFound);
    expect(claimErrorMessage({ code: "42501" })).toBe(CLAIM_MSG.generic);
  });
  it("upload errors", () => {
    expect(claimUploadErrorMessage(null)).toBeNull();
    expect(claimUploadErrorMessage({ statusCode: "409", message: "The resource already exists" })).toBeNull();
    expect(claimUploadErrorMessage({ statusCode: "413" })).toBe(CLAIM_MSG.photoTooBig);
    expect(claimUploadErrorMessage({ statusCode: "403" })).toBe(CLAIM_MSG.closed);
    expect(claimUploadErrorMessage({ message: "network error" })).toBe(CLAIM_MSG.network);
  });
});
