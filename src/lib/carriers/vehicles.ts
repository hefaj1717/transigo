// Carrier vehicles (D102, D107, D111). Pure validation; Server Actions write with the carrier's session.
import { z } from "zod";

export const VEHICLE_MSG = {
  vehicleType: "Scegli il tipo di veicolo",
  plate: "Targa non valida: da 5 a 10 lettere e numeri (es. AB123CD)",
  payload: "Indica la portata in kg (numero intero maggiore di zero)",
  payloadTooHigh: "Portata troppo alta: controlla il valore in kg",
  payloadTooLow: "Inserisci la portata in kg (es. 1200), non in tonnellate.",
  dimension: "Valore non valido: centimetri, numero intero maggiore di zero",
  dimensionTooHigh: "Misura troppo alta: controlla il valore in cm",
  dimensionTooLow: "Inserisci le misure in cm (es. 240), non in metri.",
  // D111
  plateTaken: "Questa targa è già registrata. Se il veicolo è tuo, contatta l'assistenza Transigo.",
  // D107 (shown with the "Aggiungi nuovo veicolo" button)
  plateLocked: "La targa di un veicolo approvato non si può modificare. Aggiungi un nuovo veicolo e disattiva quello vecchio.",
  // Asked in the browser before saving a new type or payload of an approved vehicle (D107)
  reverifyConfirm: "Il veicolo tornerà in verifica e non potrà accettare nuove corse fino all'approvazione. Continuare?",
} as const;

/** Upper case, without spaces and hyphens (D102). "ab 123-cd" → "AB123CD". */
export function normalizePlate(value: string): string {
  return value.toUpperCase().replace(/[\s-]+/g, "");
}

/** Same rule as the carrier_vehicles_plate_format check. */
export function isValidPlate(plate: string): boolean {
  return /^[A-Z0-9]{5,10}$/.test(plate);
}

// Bounds only catch unit typos in the form (tonnes or metres instead of kg / cm, extra zeros);
// the database requires just > 0.
export const MIN_PAYLOAD_KG = 100;
export const MAX_PAYLOAD_KG = 50_000;
export const MIN_DIMENSION_CM = 50;
export const MAX_DIMENSION_CM = 2_000;

type Bounds = { min: number; max: number; message: string; minMessage: string; maxMessage: string };

/** Form text → positive integer within bounds; empty → undefined. */
const intField = ({ min, max, message, minMessage, maxMessage }: Bounds) =>
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
      if (n < min) {
        ctx.addIssue({ code: "custom", message: minMessage });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({ code: "custom", message: maxMessage });
        return z.NEVER;
      }
      return n;
    });

const payloadBounds: Bounds = {
  min: MIN_PAYLOAD_KG, max: MAX_PAYLOAD_KG,
  message: VEHICLE_MSG.payload, minMessage: VEHICLE_MSG.payloadTooLow, maxMessage: VEHICLE_MSG.payloadTooHigh,
};
const dimensionBounds: Bounds = {
  min: MIN_DIMENSION_CM, max: MAX_DIMENSION_CM,
  message: VEHICLE_MSG.dimension, minMessage: VEHICLE_MSG.dimensionTooLow, maxMessage: VEHICLE_MSG.dimensionTooHigh,
};

export const vehicleSchema = z.object({
  vehicleTypeId: z.uuid({ error: VEHICLE_MSG.vehicleType }),
  plate: z
    .string({ error: VEHICLE_MSG.plate })
    .transform(normalizePlate)
    .pipe(z.string().refine(isValidPlate, { error: VEHICLE_MSG.plate })),
  payloadKg: intField(payloadBounds).pipe(z.number({ error: VEHICLE_MSG.payload })),
  cargoLengthCm: intField(dimensionBounds),
  cargoWidthCm: intField(dimensionBounds),
  cargoHeightCm: intField(dimensionBounds),
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

/** The form changes the type or the payload of the saved vehicle (D107 then clears the approval). */
export function changesApprovalFields(
  saved: { vehicleTypeId: string; payloadKg: string },
  submitted: { vehicleTypeId: string; payloadKg: string },
): boolean {
  const kg = (v: string) => v.replace(/\s/g, "").replace(/^0+(?=\d)/, "");
  return submitted.vehicleTypeId !== saved.vehicleTypeId || kg(submitted.payloadKg) !== kg(saved.payloadKg);
}
