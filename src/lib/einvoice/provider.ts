// Common interface of the e-invoice providers (D144). Today: the DEMO adapter (demo.ts); later Fatture in Cloud (D1)
// = a new adapter + EINVOICE_PROVIDER, without changes in the rest of the code.
import type { CreditNoteDocument, InvoiceDocument } from "./document";

export const PROVIDER_NAMES = ["demo", "fatture_in_cloud"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** = enum public.invoice_sdi_status */
export type SdiStatus = "not_sent" | "sent" | "delivered" | "rejected";

export type IssueResult = {
  providerDocumentId: string;
  /** The document number. For a real provider ALWAYS the provider's number — we never number real invoices (D145). */
  number: string;
  issuedAt: Date;
  sdiStatus: SdiStatus;
  /** PDF to keep in the private bucket `invoices`; null when the provider keeps it (then getPdf). */
  pdf: Uint8Array | null;
};

export interface EInvoiceProvider {
  readonly name: ProviderName;
  readonly isDemo: boolean;
  /**
   * Issues the invoice. `idempotencyKey` = id of the `invoices` row: a retry with the same key never issues a second
   * document (it returns the first one).
   */
  issueInvoice(doc: InvoiceDocument, idempotencyKey: string): Promise<IssueResult>;
  issueCreditNote(doc: CreditNoteDocument, idempotencyKey: string): Promise<IssueResult>;
  getStatus(providerDocumentId: string): Promise<SdiStatus>;
  /** null = the PDF was returned at issue time and is kept in the bucket. */
  getPdf(providerDocumentId: string): Promise<Uint8Array | null>;
}

/**
 * A provider / document error with a short CODE (stored in invoices.last_error_code — never personal data or a
 * provider message that could contain it).
 */
export class EInvoiceError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "EInvoiceError";
  }
}

/** The code to store for any error: EInvoiceError → its code; anything else → "provider_error". */
export function errorCode(e: unknown): string {
  if (e instanceof EInvoiceError && /^[a-z0-9_:.-]{1,200}$/.test(e.code)) return e.code;
  return "provider_error";
}
