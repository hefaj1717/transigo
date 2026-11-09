// Carrier vehicles (D102, D107, D111). Pure validation; Server Actions write with the carrier's session.
import { z } from "zod";

export const VEHICLE_MSG = {
  vehicleType: "Scegli il tipo di veicolo",
  plate: "Targa non valida: da 5 a 10 lettere e numeri (es. AB123CD)",
  payload: "Indica la portata in kg (numero intero maggiore di zero)",
  payloadTooHigh: "Portata troppo alta: controlla il valore in kg",
  dimension: "Valore non valido: centimetri, numero intero maggiore di zero",
  // D111
  plateTaken: "Questa targa è già registrata. Se il veicolo è tuo, contatta l'assistenza Transigo.",
  // D107 (shown with the "Aggiungi nuovo veicolo" button)
  plateLocked: "La targa di un veicolo approvato non si può modificare. Aggiungi un nuovo veicolo e disattiva quello vecchio.",
} as const;

/** Upper case, without spaces and hyphens (D102). "ab 123-cd" → "AB123CD". */
export function normalizePlate(value: string): string {
  return value.toUpperCase().replace(/[\s-]+/g, "");
}

/** Same rule as the carrier_vehicles_plate_format check. */
export function isValidPlate(plate: string): boolean {
  return /^[A-Z0-9]{5,10}$/.test(plate);
}

// Upper bound only catches typos (tonnes typed as kg × 1000); the database requires > 0.
export const MAX_PAYLOAD_KG = 50_000;
const MAX_DIMENSION_CM = 2_000;

/** Form text → positive integer; empty → undefined. */
const intField = (message: string, max: number, maxMessage = message) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const t = (v ?? "").trim().replace(/\s/g, "");
      if (t === "") return undefined;
      if (!/^\d+$/.test(t) || Number(t) <= 0) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      const n = Number(t);
      if (n > max) {
        ctx.addIssue({ code: "custom", message: maxMessage });
        return z.NEVER;
      }
      return n;
    });

export const vehicleSchema = z.object({
  vehicleTypeId: z.uuid({ error: VEHICLE_MSG.vehicleType }),
  plate: z
    .string({ error: VEHICLE_MSG.plate })
    .transform(normalizePlate)
    .pipe(z.string().refine(isValidPlate, { error: VEHICLE_MSG.plate })),
  payloadKg: intField(VEHICLE_MSG.payload, MAX_PAYLOAD_KG, VEHICLE_MSG.payloadTooHigh).pipe(
    z.number({ error: VEHICLE_MSG.payload }),
  ),
  cargoLengthCm: intField(VEHICLE_MSG.dimension, MAX_DIMENSION_CM),
  cargoWidthCm: intField(VEHICLE_MSG.dimension, MAX_DIMENSION_CM),
  cargoHeightCm: intField(VEHICLE_MSG.dimension, MAX_DIMENSION_CM),
});
export type VehicleInput = z.output<typeof vehicleSchema>;

/** Form values → carrier_vehicles columns (empty dimensions → null). */
export function vehicleRow(v: VehicleInput) {
  return {
    vehicle_type_id: v.vehicleTypeId,
    plate: v.plate,
    payload_kg: v.payloadKg,
    cargo_length_cm: v.cargoLengthCm ?? null,
    cargo_width_cm: v.cargoWidthCm ?? null,
    cargo_height_cm: v.cargoHeightCm ?? null,
  };
}

type DbError = { code?: string | null; message?: string | null } | null | undefined;

export type VehicleDbError = { field: "plate"; message: string; offerNewVehicle: boolean };

/** Known database errors on carrier_vehicles → Italian message on the plate field; null = unknown. */
export function vehicleDbError(error: DbError): VehicleDbError | null {
  const message = error?.message ?? "";
  if (error?.code === "23505" && message.includes("plate")) {
    return { field: "plate", message: VEHICLE_MSG.plateTaken, offerNewVehicle: false };
  }
  if (error?.code === "23514" && message.includes("plate of an approved vehicle")) {
    return { field: "plate", message: VEHICLE_MSG.plateLocked, offerNewVehicle: true };
  }
  if (error?.code === "23514" && message.includes("carrier_vehicles_plate_format")) {
    return { field: "plate", message: VEHICLE_MSG.plate, offerNewVehicle: false };
  }
  return null;
}

/** "Nuovo veicolo" / "Da riverificare" / approved (D107; admin list "Veicoli da verificare"). */
export function vehicleApprovalState(v: { approved_at: string | null; first_approved_at: string | null }): "approved" | "new" | "reverify" {
  if (v.approved_at) return "approved";
  return v.first_approved_at ? "reverify" : "new";
}
