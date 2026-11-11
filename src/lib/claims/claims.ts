// Customer claims (D138) — pure: categories, the 14-day window shown in the UI, input schema, photo paths and the
// database errors as Italian messages. The database decides (open_claim / register_claim_photo); this only mirrors
// the rules for the screens.
import { z } from "zod";

export const CLAIM_WINDOW_DAYS = 14; // = c_window in open_claim()
export const CLAIM_MAX_PHOTOS = 5; //   = c_max in register_claim_photo()

export const CLAIM_CATEGORIES = ["damaged_goods", "missing_goods", "delay", "carrier_behaviour", "other"] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

export const CLAIM_CATEGORY_LABEL: Record<ClaimCategory, string> = {
  damaged_goods: "Merce danneggiata",
  missing_goods: "Merce mancante",
  delay: "Ritardo",
  carrier_behaviour: "Comportamento del trasportatore",
  other: "Altro",
};

export const CLAIM_STATUS_LABEL: Record<"open" | "closed", string> = { open: "Aperto", closed: "Chiuso" };

/** Last moment to open a claim: delivered_at + 14 days (inclusive, like the database's `now() > deadline`). */
export function claimDeadline(deliveredAt: Date): Date {
  return new Date(deliveredAt.getTime() + CLAIM_WINDOW_DAYS * 86_400_000);
}

/** The order page shows "Apri un reclamo" (the database checks again). */
export function canOpenClaim(order: { status: string; delivered_at: string | null }, now: Date): boolean {
  if (!["delivered", "completed"].includes(order.status) || !order.delivered_at) return false;
  return now.getTime() <= claimDeadline(new Date(order.delivered_at)).getTime();
}

export const CLAIM_MSG = {
  opened: "Reclamo inviato. Ti risponderemo il prima possibile.",
  notFound: "Ordine non trovato.",
  notDelivered: "Puoi aprire un reclamo solo dopo la consegna.",
  tooLate: `Sono passati più di ${CLAIM_WINDOW_DAYS} giorni dalla consegna: contattaci per questo ordine.`,
  closed: "Il reclamo è chiuso: non puoi più aggiungere foto.",
  tooManyPhotos: `Puoi allegare al massimo ${CLAIM_MAX_PHOTOS} foto.`,
  photoInvalid: "Questa foto non è valida. Scegline un'altra.",
  photoTooBig: "La foto è troppo grande. Scegline un'altra.",
  network: "Connessione assente o lenta. Riprova.",
  generic: "Si è verificato un errore. Riprova tra qualche istante.",
} as const;

export const openClaimSchema = z.object({
  orderId: z.uuid(),
  category: z.enum(CLAIM_CATEGORIES, { error: "Scegli il tipo di problema." }),
  description: z.string().trim().min(10, "Descrivi il problema (almeno 10 caratteri).").max(4000, "Massimo 4000 caratteri."),
});
export type OpenClaimInput = z.input<typeof openClaimSchema>;

/** {claim_id}/{uuid}.jpg — the only shape the bucket policy and register_claim_photo accept. */
export const claimPhotoPath = (claimId: string, fileId: string) => `${claimId}/${fileId}.jpg`;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function isClaimPhotoPath(claimId: string, path: string): boolean {
  return new RegExp(`^${claimId}/${UUID}\\.jpg$`).test(path);
}

type DbError = { code?: string; details?: string } | null | undefined;

/** open_claim / register_claim_photo errors → message for the customer. */
export function claimErrorMessage(error: DbError): string {
  switch (error?.details) {
    case "order":
    case "claim":
      return CLAIM_MSG.notFound;
    case "description":
      return "Descrivi il problema (10–4000 caratteri).";
    case "category":
      return "Scegli il tipo di problema.";
    case "not_delivered":
      return CLAIM_MSG.notDelivered;
    case "too_late":
      return CLAIM_MSG.tooLate;
    case "closed":
      return CLAIM_MSG.closed;
    case "too_many_photos":
      return CLAIM_MSG.tooManyPhotos;
    case "path":
    case "file":
      return CLAIM_MSG.photoInvalid;
    default:
      return CLAIM_MSG.generic;
  }
}

/** Storage error of the direct upload → message (no status = network). */
export function claimUploadErrorMessage(error: { statusCode?: string | number; message?: string } | null): string | null {
  if (!error) return null;
  const code = String(error.statusCode ?? "");
  if (code === "409" || /already exists|duplicate/i.test(error.message ?? "")) return null; // arrived before: register it
  if (code === "413") return CLAIM_MSG.photoTooBig;
  if (code === "403") return CLAIM_MSG.closed;
  if (code === "400" || code === "415" || code === "422") return CLAIM_MSG.photoInvalid;
  return CLAIM_MSG.network;
}
