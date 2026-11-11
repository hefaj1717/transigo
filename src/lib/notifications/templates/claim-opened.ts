import { CLAIM_CATEGORY_LABEL, type ClaimCategory } from "@/lib/claims/claims";
import { escapeHtml, type RenderedEmail } from "./common";

// "Nuovo reclamo" e-mail to the Transigo team (D138). No customer data: order number, category, number of photos
// and the link to the admin panel. One e-mail per claim (outbox key = claim id, D129).

export const CLAIM_OPENED_TEMPLATE = "claim_opened";

export type ClaimOpenedData = { orderNumber: string; category: ClaimCategory; adminUrl: string };

export function renderClaimOpenedEmail(d: ClaimOpenedData): RenderedEmail {
  const category = CLAIM_CATEGORY_LABEL[d.category];
  const subject = `Nuovo reclamo – ${d.orderNumber}`;
  const text = ["Ciao,", "", `il cliente ha aperto un reclamo per l'ordine ${d.orderNumber}.`, `Tipo: ${category}`, "", `Apri l'ordine: ${d.adminUrl}`, "", "Transigo"].join("\n");
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="it"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>Ciao,</p>
<p>il cliente ha aperto un reclamo per l'ordine <strong>${e(d.orderNumber)}</strong>.<br>Tipo: ${e(category)}</p>
<p><a href="${e(d.adminUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Apri l'ordine</a></p>
<p style="color:#71717a">Transigo</p>
</body></html>`;
  return { subject, html, text };
}
