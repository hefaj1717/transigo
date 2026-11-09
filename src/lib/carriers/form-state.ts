import type { FieldErrors } from "@/lib/auth/schemas";

/** State of carrier onboarding forms (useActionState). */
export type CarrierFormState = {
  /** Per-field messages; "_form" = whole form. */
  errors?: FieldErrors;
  message?: string;
  /** Submitted values to refill the form after an error. */
  values?: Record<string, string>;
  /** D107: the plate of an approved vehicle cannot change → offer "Aggiungi nuovo veicolo". */
  offerNewVehicle?: boolean;
};

export const initialCarrierFormState: CarrierFormState = {};
