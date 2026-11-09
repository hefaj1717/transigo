// What the site stores in the visitor's browser (D125, D126). Single source for the cookie policy page and
// the banner: only technical storage, no analytics or profiling. Adding analytics or third-party scripts
// requires a consent banner with categories instead of the informative "Ok" notice.

export const COOKIE_NOTICE_STORAGE_KEY = "transigo.cookie-notice.v1";

export type StorageItem = { name: string; kind: "Cookie" | "Archiviazione locale"; purpose: string; duration: string };

export const BROWSER_STORAGE: StorageItem[] = [
  {
    name: "sb-…-auth-token",
    kind: "Cookie",
    purpose: "Mantiene l'accesso al tuo account (cookie tecnico di sessione, necessario).",
    duration: "Fino all'uscita dall'account o alla scadenza della sessione",
  },
  {
    name: "transigo.booking.v1",
    kind: "Archiviazione locale",
    purpose: "Ricorda percorso, data, merce e servizi della prenotazione in corso. Non contiene dati personali e viene cancellata dopo l'ordine.",
    duration: "Fino al completamento dell'ordine o alla cancellazione dal browser",
  },
  {
    name: COOKIE_NOTICE_STORAGE_KEY,
    kind: "Archiviazione locale",
    purpose: "Ricorda che hai chiuso l'avviso sui cookie.",
    duration: "Fino alla cancellazione dal browser",
  },
];
