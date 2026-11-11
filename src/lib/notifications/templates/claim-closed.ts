import { CLAIM_CATEGORY_LABEL, type ClaimCategory } from "@/lib/claims/claims";
import { escapeHtml, type RenderedEmail } from "./common";

// "Reclamo chiuso" e-mail to the customer (D138): the team's note (the same text the customer sees in "Reclami")
// and the link. One e-mail per claim (outbox key = claim id, D129).

export const CLAIM_CLOSED_TEMPLATE = "claim_closed";

export type ClaimClosedData = { firstName: string | null; orderNumber: string; category: ClaimCategory; note: string; claimsUrl: string };

export function renderClaimClosedEmail(d: ClaimClosedData): RenderedEmail {
  const category = CLAIM_CATEGORY_LABEL[d.category];
  const greeting = d.firstName ? `Ciao ${d.firstName},` : "Ciao,";
  const subject = `Il tuo reclamo è stato chiuso – ordine ${d.orderNumber}`;
  const text = [
    greeting, "",
    `abbiamo chiuso il tuo reclamo per l'ordine ${d.orderNumber} (${category}).`, "",
    "La nostra risposta:", d.note, "",
    `Vedi i tuoi reclami: ${d.claimsUrl}`, "",
    "Per qualsiasi domanda rispondi a questa e-mail o scrivici dalla pagina Contatti.", "",
    "Il team Transigo",
  ].join("\n");
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="it"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>${e(greeting)}</p>
<p>abbiamo chiuso il tuo reclamo per l'ordine <strong>${e(d.orderNumber)}</strong> (${e(category)}).</p>
<p style="margin-bottom:4px"><strong>La nostra risposta:</strong></p>
<p style="white-space:pre-line;background:#f4f4f5;padding:12px;border-radius:6px;margin-top:0">${e(d.note)}</p>
<p><a href="${e(d.claimsUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">I miei reclami</a></p>
<p style="color:#71717a">Per qualsiasi domanda rispondi a questa e-mail o scrivici dalla pagina Contatti.<br>Il team Transigo</p>
</body></html>`;
  return { subject, html, text };
}
