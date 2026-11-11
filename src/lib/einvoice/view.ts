// Invoice screens (pure, tested): labels, notes grouped under their invoice, admin tabs, PDF file name.
// Customer screens never show our technical state ("failed", error codes): a document that is not issued yet is
// "In preparazione".

export type DocRow = {
  id: string;
  kind: "invoice" | "credit_note";
  order_id: string;
  invoice_id: string | null;
  refund_id: string | null;
  status: "pending" | "issued" | "failed";
  sdi_status: "not_sent" | "sent" | "delivered" | "rejected" | null;
  number: string | null;
  issued_at: string | null;
  is_demo: boolean;
  net_cents: number;
  vat_cents: number;
  total_cents: number;
  pdf_path: string | null;
  created_at: string;
};

export type InvoiceGroup<T extends DocRow = DocRow> = { invoice: T; notes: T[] };

export const DOC_KIND_LABEL: Record<DocRow["kind"], string> = { invoice: "Fattura", credit_note: "Nota di credito" };

export const CUSTOMER_DOC_STATUS: Record<DocRow["status"], string> = { pending: "In preparazione", failed: "In preparazione", issued: "Emessa" };
export const ADMIN_DOC_STATUS: Record<DocRow["status"], string> = { pending: "Da emettere", failed: "In errore", issued: "Emessa" };
export const SDI_STATUS_LABEL: Record<NonNullable<DocRow["sdi_status"]>, string> = {
  not_sent: "Non inviata allo SDI", sent: "Inviata allo SDI", delivered: "Consegnata (SDI)", rejected: "Scartata dallo SDI",
};

/** Invoices newest first, each with its credit notes (oldest first). Orphan notes (no invoice row) are dropped. */
export function groupDocuments<T extends DocRow>(rows: readonly T[]): InvoiceGroup<T>[] {
  const invoices = rows.filter((r) => r.kind === "invoice").sort((a, b) => b.created_at.localeCompare(a.created_at));
  return invoices.map((invoice) => ({
    invoice,
    notes: rows.filter((r) => r.kind === "credit_note" && r.invoice_id === invoice.id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
  }));
}

/** The PDF can be downloaded: issued and stored. */
export const canDownload = (d: Pick<DocRow, "status" | "pdf_path">) => d.status === "issued" && !!d.pdf_path;

/** "Fattura_DEMO-2026-0001.pdf" — safe characters only. */
export function pdfFileName(d: Pick<DocRow, "kind" | "number">): string {
  const base = `${d.kind === "invoice" ? "Fattura" : "Nota_di_credito"}_${d.number ?? "documento"}`;
  return `${base.replace(/[^A-Za-z0-9._-]+/g, "_")}.pdf`;
}

export const INVOICE_PDF_PATH = (id: string) => `/api/fatture/${id}/pdf`;

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
export const ADMIN_INVOICE_TABS = [
  { key: "da-emettere", label: "Da emettere / in errore" },
  { key: "emesse", label: "Emesse" },
] as const;
export type AdminInvoiceTab = (typeof ADMIN_INVOICE_TABS)[number]["key"];

export function parseAdminInvoiceTab(v: unknown): AdminInvoiceTab {
  return v === "emesse" ? "emesse" : "da-emettere";
}

export const ADMIN_INVOICE_PATHS = {
  list: "/admin/fatture",
  tab: (t: AdminInvoiceTab) => (t === "da-emettere" ? "/admin/fatture" : `/admin/fatture?stato=${t}`),
};

/** Error codes shown to the admin (Italian); unknown codes are shown as they are. */
const ERROR_LABEL: Record<string, string> = {
  provider_error: "errore del fornitore",
  provider_timeout: "il fornitore non ha risposto",
  provider_mismatch: "fornitore diverso da quello configurato",
  provider_not_configured: "fornitore non configurato",
  provider_config: "configurazione del fornitore non valida",
  demo_on_production: "adattatore DEMO disattivato in produzione",
  amount_mismatch: "importi incoerenti",
  buyer_missing: "dati di fatturazione mancanti",
  pdf_store_failed: "PDF non salvato",
  demo_number_reserve_failed: "numero DEMO non assegnato",
  demo_number_invalid: "numero DEMO non valido",
};
export const errorLabel = (code: string | null) => (code ? (ERROR_LABEL[code] ?? code) : null);

export const INVOICE_ADMIN_MSG = {
  generic: "Operazione non riuscita. Riprova.",
  retried: "Documento emesso.",
  retryFailed: "Il documento è ancora in errore: controlla il codice e riprova più tardi.",
  alreadyIssued: "Il documento è già stato emesso.",
  queued: "Documento rimesso in coda: verrà emesso dal job periodico.",
} as const;

/** Validity of the signed PDF URL (D148). */
export const PDF_URL_SECONDS = 60;
