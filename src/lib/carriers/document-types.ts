// Carrier document types (D98). One configuration, mirrored by the table public.carrier_document_types
// (seeded in supabase/migrations/20261109120000_carrier_onboarding.sql). tests/rls/carrier-onboarding.test.ts
// checks that both are equal — change them together (new migration + this file).

export type CarrierDocumentType =
  | "transport_license"
  | "driving_license"
  | "goods_insurance"
  | "vehicle_registration"
  | "insurance_rca"
  | "identity_document";

export type CarrierDocumentTypeConfig = {
  docType: CarrierDocumentType;
  /** carrier = company / owner document; vehicle = one per vehicle (vehicle_id required). */
  scope: "carrier" | "vehicle";
  /** Needed before the account can be sent for review and approved. */
  isRequired: boolean;
  /** false = no new uploads (kept for existing rows). */
  isAccepted: boolean;
  /** none = no expiry date allowed; required = date required. */
  expiry: "none" | "required";
  labelIt: string;
  /** Label of the date field; null when expiry = "none". */
  expiryLabelIt: string | null;
  sortOrder: number;
};

export const CARRIER_DOCUMENT_TYPES: readonly CarrierDocumentTypeConfig[] = [
  { docType: "transport_license", scope: "carrier", isRequired: true, isAccepted: true, expiry: "none", labelIt: "Iscrizione all'Albo degli autotrasportatori", expiryLabelIt: null, sortOrder: 10 },
  { docType: "driving_license", scope: "carrier", isRequired: true, isAccepted: true, expiry: "required", labelIt: "Patente del titolare", expiryLabelIt: "Scadenza", sortOrder: 20 },
  { docType: "goods_insurance", scope: "carrier", isRequired: false, isAccepted: true, expiry: "required", labelIt: "Polizza RC vettoriale", expiryLabelIt: "Scadenza", sortOrder: 30 },
  { docType: "vehicle_registration", scope: "vehicle", isRequired: true, isAccepted: true, expiry: "required", labelIt: "Libretto di circolazione", expiryLabelIt: "Prossima revisione", sortOrder: 40 },
  { docType: "insurance_rca", scope: "vehicle", isRequired: true, isAccepted: true, expiry: "required", labelIt: "Assicurazione RCA", expiryLabelIt: "Scadenza", sortOrder: 50 },
  // Identity is verified by Stripe Connect (D97); not uploaded.
  { docType: "identity_document", scope: "carrier", isRequired: false, isAccepted: false, expiry: "none", labelIt: "Documento d'identità", expiryLabelIt: null, sortOrder: 90 },
];

export function documentTypeConfig(docType: CarrierDocumentType): CarrierDocumentTypeConfig {
  const cfg = CARRIER_DOCUMENT_TYPES.find((t) => t.docType === docType);
  if (!cfg) throw new Error(`Unknown carrier document type: ${docType}`);
  return cfg;
}

/** Types a carrier can upload for the given scope, in display order. */
export function uploadableDocumentTypes(scope: "carrier" | "vehicle"): CarrierDocumentTypeConfig[] {
  return CARRIER_DOCUMENT_TYPES.filter((t) => t.scope === scope && t.isAccepted).sort((a, b) => a.sortOrder - b.sortOrder);
}
