// Carrier document files (D98, D103). Pure: the browser checks the file before uploading it to Storage,
// the Server Action checks the path and the expiry again and takes size and type from Storage metadata.
import { z } from "zod";
import { romeDate } from "@/lib/pricing/calendar";
import { documentTypeConfig, type CarrierDocumentType, CARRIER_DOCUMENT_TYPES } from "./document-types";

/** Same limit as the carrier-documents bucket and carrier_documents.size_bytes. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type DocumentMime = "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | "image/heic";
export type DocumentExt = "pdf" | "jpg" | "png" | "webp" | "heic";

/** Storage path extension per type (carrier_documents_storage_path_format). */
export const EXT_BY_MIME: Record<DocumentMime, DocumentExt> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

const MIME_BY_FILE_EXT: Record<string, DocumentMime> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
};

/** <input type="file" accept> value. */
export const DOCUMENT_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/jpeg,image/png,image/webp,image/heic";

export const DOCUMENT_MSG = {
  type: "Formato non supportato: carica un PDF o una foto (JPG, PNG, WEBP, HEIC).",
  empty: "Il file è vuoto.",
  tooLarge: "Il file supera 10 MB. Carica un file più piccolo o una foto a risoluzione più bassa.",
  fileName: "Nome del file non valido.",
  dateRequired: (label: string) => `Indica la data: ${label}.`,
  dateInvalid: "Data non valida.",
  dateNotAllowed: "Questo documento non ha una data di scadenza.",
  expired: "Il documento risulta scaduto: carica un documento in corso di validità.",
  docType: "Tipo di documento non valido.",
  vehicle: "Scegli il veicolo a cui appartiene il documento.",
  notVehicle: "Questo documento non riguarda un veicolo.",
  upload: "Caricamento non riuscito. Controlla la connessione e riprova.",
  fileMissing: "Il file non risulta caricato. Riprova.",
} as const;

export type ResolvedFile = { ok: true; mimeType: DocumentMime; ext: DocumentExt } | { ok: false; error: string };

const isMime = (t: string): t is DocumentMime => t in EXT_BY_MIME;

/**
 * Checks a file chosen by the carrier. The browser's type wins when it is one of ours; an empty or generic
 * type (some phones send HEIC without a type) falls back to the file extension.
 */
export function resolveDocumentFile(file: { name: string; type: string; size: number }): ResolvedFile {
  if (file.size <= 0) return { ok: false, error: DOCUMENT_MSG.empty };
  if (file.size > MAX_DOCUMENT_BYTES) return { ok: false, error: DOCUMENT_MSG.tooLarge };
  const type = file.type.trim().toLowerCase();
  let mime: DocumentMime | undefined;
  if (isMime(type)) {
    mime = type;
  } else if (type === "" || type === "application/octet-stream") {
    const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    mime = ext ? MIME_BY_FILE_EXT[ext] : undefined;
  }
  if (!mime) return { ok: false, error: DOCUMENT_MSG.type };
  return { ok: true, mimeType: mime, ext: EXT_BY_MIME[mime] };
}

/** {carrier_id}/{uuid}.{ext} (D98). */
export function documentStoragePath(carrierId: string, fileId: string, ext: DocumentExt): string {
  return `${carrierId}/${fileId}.${ext}`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Parses a path sent by the browser; null when it is not in the carrier's own folder or not in our format. */
export function parseDocumentStoragePath(path: string, carrierId: string): { fileName: string; ext: DocumentExt } | null {
  const m = path.match(new RegExp(`^${UUID}/(${UUID})\\.(pdf|jpg|png|webp|heic)$`));
  if (!m || !path.startsWith(`${carrierId}/`)) return null;
  return { fileName: `${m[1]}.${m[2]}`, ext: m[2] as DocumentExt };
}

/** Today in Italy (YYYY-MM-DD) — documents count while expires_at >= today in Europe/Rome (D99). */
export function romeToday(now: Date = new Date()): string {
  return romeDate(now).date;
}

const isIsoDate = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export type ExpiryCheck = { ok: true; expiresAt: string | null } | { ok: false; error: string };

/** Expiry date for the document type (D98): required and not in the past, or not allowed. */
export function checkDocumentExpiry(docType: CarrierDocumentType, value: string | null | undefined, today: string): ExpiryCheck {
  const cfg = documentTypeConfig(docType);
  const v = (value ?? "").trim();
  if (cfg.expiry === "none") return v ? { ok: false, error: DOCUMENT_MSG.dateNotAllowed } : { ok: true, expiresAt: null };
  if (!v) return { ok: false, error: DOCUMENT_MSG.dateRequired(cfg.expiryLabelIt ?? "Scadenza") };
  if (!isIsoDate(v) || v > "2100-12-31") return { ok: false, error: DOCUMENT_MSG.dateInvalid };
  if (v < today) return { ok: false, error: DOCUMENT_MSG.expired };
  return { ok: true, expiresAt: v };
}

const ACCEPTED_TYPES = CARRIER_DOCUMENT_TYPES.filter((t) => t.isAccepted).map((t) => t.docType) as [CarrierDocumentType, ...CarrierDocumentType[]];

/** Input of the Server Action that records an uploaded file (after the browser uploaded it to Storage). */
export const documentUploadSchema = z
  .object({
    docType: z.enum(ACCEPTED_TYPES, { error: DOCUMENT_MSG.docType }),
    vehicleId: z
      .string()
      .optional()
      .transform((v) => v?.trim() || undefined)
      .pipe(z.uuid({ error: DOCUMENT_MSG.vehicle }).optional()),
    storagePath: z.string().min(1).max(200),
    fileName: z.string().trim().min(1, { error: DOCUMENT_MSG.fileName }).max(255, { error: DOCUMENT_MSG.fileName }),
    expiresAt: z.string().optional(),
  })
  .superRefine((d, ctx) => {
    const scope = documentTypeConfig(d.docType).scope;
    if (scope === "vehicle" && !d.vehicleId) ctx.addIssue({ code: "custom", message: DOCUMENT_MSG.vehicle, path: ["vehicleId"] });
    if (scope === "carrier" && d.vehicleId) ctx.addIssue({ code: "custom", message: DOCUMENT_MSG.notVehicle, path: ["vehicleId"] });
  });
export type DocumentUploadInput = z.output<typeof documentUploadSchema>;
