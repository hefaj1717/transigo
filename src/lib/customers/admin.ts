// Admin "Clienti" (spec 9, D143) — pure: paths, block reasons, the block form, the search term, messages.
import { z } from "zod";

export const ADMIN_CUSTOMER_PATHS = {
  list: "/admin/clienti",
  detail: (id: string) => `/admin/clienti/${id}`,
} as const;

/** Reason codes of a block (= admin_set_customer_blocked); details go to the internal notes, never to the audit. */
export const BLOCK_REASONS = [
  { code: "payment_issue", label: "Problemi di pagamento" },
  { code: "abuse", label: "Comportamento scorretto" },
  { code: "fraud_suspected", label: "Sospetta frode" },
  { code: "customer_request", label: "Richiesta del cliente" },
  { code: "other", label: "Altro" },
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number]["code"];
export const BLOCK_REASON_LABEL: Record<string, string> = Object.fromEntries(BLOCK_REASONS.map((r) => [r.code, r.label]));

export const CUSTOMER_ADMIN_MSG = {
  blocked: (activeOrders: number) =>
    activeOrders > 0
      ? `Cliente bloccato. ${activeOrders === 1 ? "1 ordine in corso continua" : `${activeOrders} ordini in corso continuano`} normalmente.`
      : "Cliente bloccato: non può più accedere.",
  unblocked: "Cliente sbloccato: può di nuovo accedere.",
  unchanged: "Lo stato era già questo. Ricarica la pagina.",
  chooseReason: "Scegli il motivo del blocco.",
  notFound: "Cliente non trovato.",
  generic: "Operazione non riuscita. Riprova.",
} as const;

export const blockSchema = z.discriminatedUnion("block", [
  z.object({ customerId: z.uuid(), block: z.literal("1"), reason: z.enum(BLOCK_REASONS.map((r) => r.code) as [BlockReason, ...BlockReason[]]) }),
  z.object({ customerId: z.uuid(), block: z.literal("0") }),
]);

/**
 * The search box → a safe term for PostgREST `ilike` / `or` filters: no wildcards or filter syntax
 * (`%`, `_`, `*`, `,`, `(`, `)`, `\`, quotes; dots stay — e-mails), spaces collapsed, at most 100 characters. Empty → null.
 */
export function customerSearchTerm(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.replace(/[%_*,()\\"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return t.length >= 2 ? t : null;
}

export const CUSTOMER_TYPE_LABEL: Record<string, string> = { private: "Privato", business: "Azienda" };

/** Name shown in the lists: company for a business, otherwise first + last name, otherwise the e-mail. */
export function customerDisplayName(c: { customer_type: string; company_name: string | null; first_name: string | null; last_name: string | null; email: string }): string {
  if (c.customer_type === "business" && c.company_name) return c.company_name;
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email;
}
