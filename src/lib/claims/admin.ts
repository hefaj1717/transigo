// Admin side of the claims (spec 9 "Reclami", D138) — pure: paths, tabs, the close form, messages.
import { z } from "zod";

export const ADMIN_CLAIM_PATHS = {
  list: "/admin/reclami",
  detail: (id: string) => `/admin/reclami/${id}`,
} as const;

export const ADMIN_CLAIM_TABS = [
  { key: "aperti", label: "Aperti", status: "open" },
  { key: "chiusi", label: "Chiusi", status: "closed" },
] as const;
export type AdminClaimTab = (typeof ADMIN_CLAIM_TABS)[number];
export const parseAdminClaimTab = (v: unknown): AdminClaimTab => ADMIN_CLAIM_TABS.find((t) => t.key === v) ?? ADMIN_CLAIM_TABS[0];

export const CLAIM_NOTE_MAX = 4000; // = admin_close_claim / claims.resolution_note

export const CLAIM_ADMIN_MSG = {
  closed: "Reclamo chiuso: il cliente vede la risposta e riceve un'e-mail.",
  alreadyClosed: "Il reclamo era già chiuso. Ricarica la pagina.",
  noteRequired: `Scrivi la risposta per il cliente (massimo ${CLAIM_NOTE_MAX} caratteri).`,
  notFound: "Reclamo non trovato.",
  generic: "Operazione non riuscita. Riprova.",
} as const;

export const closeClaimSchema = z.object({
  claimId: z.uuid(),
  note: z.string().trim().min(1).max(CLAIM_NOTE_MAX),
});

/** "da 3 giorni" — how long a claim has been open (whole days, Europe/Rome is not needed for a duration). */
export function claimAgeLabel(createdAt: Date, now: Date): string {
  const days = Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000);
  if (days <= 0) return "oggi";
  return days === 1 ? "da 1 giorno" : `da ${days} giorni`;
}
