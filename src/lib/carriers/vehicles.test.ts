import { describe, expect, it } from "vitest";
import { isValidPlate, normalizePlate, VEHICLE_MSG, vehicleApprovalState, vehicleDbError, vehicleRow, vehicleSchema } from "./vehicles";

const TYPE = "22222222-2222-4222-8222-222222222222";
const form = (extra: Record<string, string> = {}) => ({ vehicleTypeId: TYPE, plate: "ab 123-cd", payloadKg: "1200", ...extra });
const errors = (input: Record<string, string>) => {
  const r = vehicleSchema.safeParse(input);
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message]));
};

describe("plate (D102)", () => {
  it("normalises to upper case without spaces and hyphens", () => {
    expect(normalizePlate(" ab 123-cd ")).toBe("AB123CD");
    expect(normalizePlate("fg-456 hj")).toBe("FG456HJ");
  });
  it("accepts 5–10 letters and digits only", () => {
    expect(isValidPlate("AB123CD")).toBe(true);
    expect(isValidPlate("AB12")).toBe(false);
    expect(isValidPlate("AB123CD45678")).toBe(false);
    expect(isValidPlate("AB.123")).toBe(false);
  });
});

describe("vehicleSchema", () => {
  it("parses a vehicle and maps it to columns (empty dimensions → null)", () => {
    const v = vehicleSchema.parse(form({ cargoLengthCm: "320", cargoWidthCm: "", payloadKg: " 1 200 " }));
    expect(vehicleRow(v)).toEqual({
      vehicle_type_id: TYPE, plate: "AB123CD", payload_kg: 1200, cargo_length_cm: 320, cargo_width_cm: null, cargo_height_cm: null,
    });
  });
  it("payload is required, a positive integer, with a sanity limit", () => {
    expect(errors(form({ payloadKg: "" })).payloadKg).toBe(VEHICLE_MSG.payload);
    expect(errors(form({ payloadKg: "0" })).payloadKg).toBe(VEHICLE_MSG.payload);
    expect(errors(form({ payloadKg: "12,5" })).payloadKg).toBe(VEHICLE_MSG.payload);
    expect(errors(form({ payloadKg: "60000" })).payloadKg).toBe(VEHICLE_MSG.payloadTooHigh);
  });
  it("rejects a bad plate, type or dimension", () => {
    expect(errors(form({ plate: "A-1" })).plate).toBe(VEHICLE_MSG.plate);
    expect(errors(form({ vehicleTypeId: "" })).vehicleTypeId).toBe(VEHICLE_MSG.vehicleType);
    expect(errors(form({ cargoHeightCm: "-5" })).cargoHeightCm).toBe(VEHICLE_MSG.dimension);
  });
});

describe("vehicleDbError (D107, D111)", () => {
  it("plate already registered", () => {
    expect(vehicleDbError({ code: "23505", message: 'duplicate key value violates unique constraint "carrier_vehicles_plate_key"' }))
      .toEqual({ field: "plate", message: VEHICLE_MSG.plateTaken, offerNewVehicle: false });
  });
  it("plate of an approved vehicle → message with the 'Aggiungi nuovo veicolo' button", () => {
    expect(vehicleDbError({ code: "23514", message: "carrier_vehicles: the plate of an approved vehicle cannot be changed" }))
      .toEqual({ field: "plate", message: VEHICLE_MSG.plateLocked, offerNewVehicle: true });
  });
  it("unknown errors are not mapped", () => {
    expect(vehicleDbError({ code: "42501", message: "permission denied" })).toBeNull();
    expect(vehicleDbError(null)).toBeNull();
  });
});

describe("vehicleApprovalState (D107)", () => {
  it("approved / new / to be verified again", () => {
    expect(vehicleApprovalState({ approved_at: "2026-11-09T10:00:00Z", first_approved_at: "2026-11-09T10:00:00Z" })).toBe("approved");
    expect(vehicleApprovalState({ approved_at: null, first_approved_at: null })).toBe("new");
    expect(vehicleApprovalState({ approved_at: null, first_approved_at: "2026-11-09T10:00:00Z" })).toBe("reverify");
  });
});
