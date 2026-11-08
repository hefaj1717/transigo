import { formatCents } from "../../pricing/money";
import { escapeHtml, type RenderedEmail } from "./common";

// "Pagamento confermato" e-mail (spec 13), sent after the Stripe webhook marked the order paid (D93).
// Pure: the caller loads the data. No carrier amounts, no internal notes.

export type OrderPaidData = {
  firstName: string | null;
  orderNumber: string;
  pickupCity: string;
  deliveryCity: string;
  pickupWindowStart: Date;
  pickupWindowEnd: Date;
  totalCents: number;
  customerType: "private" | "business";
  orderUrl: string;
};

const romeDate = (d: Date) => d.toLocaleDateString("it-IT", { timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "long", year: "numeric" });
const romeTime = (d: Date) => d.toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });

export function renderOrderPaidEmail(d: OrderPaidData): RenderedEmail {
  const greeting = d.firstName ? `Ciao ${d.firstName},` : "Ciao,";
  const when = `${romeDate(d.pickupWindowStart)}, tra le ${romeTime(d.pickupWindowStart)} e le ${romeTime(d.pickupWindowEnd)}`;
  const total = `${formatCents(d.totalCents)}${d.customerType === "business" ? " (IVA inclusa)" : ""}`;
  const subject = `Pagamento confermato – ordine ${d.orderNumber}`;

  const text = [
    greeting,
    "",
    `abbiamo ricevuto il pagamento del tuo ordine ${d.orderNumber}. Grazie!`,
    "",
    `Percorso: ${d.pickupCity} → ${d.deliveryCity}`,
    `Ritiro: ${when}`,
    `Totale pagato: ${total}`,
    "",
    "Ti avviseremo quando un trasportatore avrà preso in carico l'ordine. La fattura elettronica ti arriverà tramite il Sistema di Interscambio (SDI).",
    "",
    `Dettagli dell'ordine: ${d.orderUrl}`,
    "",
    "Il team Transigo",
  ].join("\n");

  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="it"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>${e(greeting)}</p>
<p>abbiamo ricevuto il pagamento del tuo ordine <strong>${e(d.orderNumber)}</strong>. Grazie!</p>
<table style="border-collapse:collapse;margin:16px 0">
<tr><td style="padding:4px 12px 4px 0;color:#71717a">Percorso</td><td style="padding:4px 0">${e(d.pickupCity)} → ${e(d.deliveryCity)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#71717a">Ritiro</td><td style="padding:4px 0">${e(when)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#71717a">Totale pagato</td><td style="padding:4px 0"><strong>${e(total)}</strong></td></tr>
</table>
<p>Ti avviseremo quando un trasportatore avrà preso in carico l'ordine. La fattura elettronica ti arriverà tramite il Sistema di Interscambio (SDI).</p>
<p><a href="${e(d.orderUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Vedi l'ordine</a></p>
<p style="color:#71717a">Il team Transigo</p>
</body></html>`;

  return { subject, html, text };
}
