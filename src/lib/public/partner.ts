// "Diventa partner": documents a carrier needs, taken from the onboarding configuration (D98) so the public
// page never drifts from what the app actually asks for.
import { CARRIER_DOCUMENT_TYPES } from "@/lib/carriers/document-types";

export type PartnerDocument = { label: string; perVehicle: boolean; required: boolean };

export function partnerDocuments(): PartnerDocument[] {
  return CARRIER_DOCUMENT_TYPES.filter((t) => t.isAccepted)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => ({ label: t.labelIt, perVehicle: t.scope === "vehicle", required: t.isRequired }));
}
