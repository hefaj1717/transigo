import { summaryRows, type OrderSummary } from "../../orders/order-summary";
import { formatCents } from "../../pricing/money";
import { escapeHtml, type RenderedEmail } from "./common";

// "Pagamento confermato" e-mail (spec 13), sent after the Stripe webhook marked the order paid (D93).
// Pure: the caller loads the data. No carrier amounts, no internal notes. Rows and the next step per service (D151).

export type OrderPaidData = {
  firstName: string | null;
  orderNumber: string;
  summary: OrderSummary;
  totalCents: number;
  customerType: "private" | "business";
  orderUrl: string;
};

const NEXT_STEP: Record<OrderSummary["service"], string> = {
  transport: "Ti avviseremo quando un trasportatore avrà preso in carico l'ordine.",
  porters: "Ti avviseremo quando una squadra di facchini avrà preso in carico l'ordine.",
  storage: "Ti contatteremo con le indicazioni per portare la merce in magazzino.",
};

export function renderOrderPaidEmail(d: OrderPaidData): RenderedEmail {
  const greeting = d.firstName ? `Ciao ${d.firstName},` : "Ciao,";
  const total = `${formatCents(d.totalCents)}${d.customerType === "business" ? " (IVA inclusa)" : ""}`;
  const subject = `Pagamento confermato – ordine ${d.orderNumber}`;
  const rows: [string, string][] = [...summaryRows(d.summary), ["Totale pagato", total]];
  const next = `${NEXT_STEP[d.summary.service]} La fattura elettronica ti arriverà tramite il Sistema di Interscambio (SDI).`;

  const text = [
    greeting,
    "",
    `abbiamo ricevuto il pagamento del tuo ordine ${d.orderNumber}. Grazie!`,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    next,
    "",
    `Dettagli dell'ordine: ${d.orderUrl}`,
    "",
    "Il team Transigo",
  ].join("\n");

  const e = escapeHtml;
  const cell = (k: string, v: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#71717a">${e(k)}</td><td style="padding:4px 0">${k === "Totale pagato" ? `<strong>${e(v)}</strong>` : e(v)}</td></tr>`;
  const html = `<!doctype html>
<html lang="it"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>${e(greeting)}</p>
<p>abbiamo ricevuto il pagamento del tuo ordine <strong>${e(d.orderNumber)}</strong>. Grazie!</p>
<table style="border-collapse:collapse;margin:16px 0">
${rows.map(([k, v]) => cell(k, v)).join("\n")}
</table>
<p>${e(next)}</p>
<p><a href="${e(d.orderUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Vedi l'ordine</a></p>
<p style="color:#71717a">Il team Transigo</p>
</body></html>`;

  return { subject, html, text };
}
