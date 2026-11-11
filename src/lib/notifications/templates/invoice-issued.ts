import { formatCents } from "@/lib/pricing/money";
import { escapeHtml, type RenderedEmail } from "./common";

// "Fattura / nota di credito disponibile" (plan docs/plany/faktury.md, section 4): a link to "Fatture", no attachment
// (the PDF is downloaded with the customer's session, D148). One e-mail per document (outbox key = document id).

export const INVOICE_ISSUED_TEMPLATE = "invoice_issued";

export type InvoiceIssuedData = {
  kind: "invoice" | "credit_note";
  firstName: string | null;
  number: string;
  orderNumber: string;
  totalCents: number;
  isDemo: boolean;
  invoicesUrl: string;
};

export function renderInvoiceIssuedEmail(d: InvoiceIssuedData): RenderedEmail {
  const what = d.kind === "invoice" ? "la fattura" : "la nota di credito";
  const What = d.kind === "invoice" ? "Fattura" : "Nota di credito";
  const greeting = d.firstName ? `Ciao ${d.firstName},` : "Ciao,";
  const subject = `${What} ${d.number} – ordine ${d.orderNumber}`;
  const amount = formatCents(d.totalCents);
  const demo = d.isDemo ? "Documento DEMO senza valore fiscale (ambiente di prova)." : null;
  const text = [
    greeting, "",
    `è disponibile ${what} n. ${d.number} per l'ordine ${d.orderNumber} (${amount}).`,
    ...(demo ? ["", demo] : []), "",
    `Scaricala dalla pagina Fatture: ${d.invoicesUrl}`, "",
    "Il team Transigo",
  ].join("\n");
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="it"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>${e(greeting)}</p>
<p>è disponibile ${e(what)} n. <strong>${e(d.number)}</strong> per l'ordine <strong>${e(d.orderNumber)}</strong> (${e(amount)}).</p>
${demo ? `<p style="color:#b91c1c">${e(demo)}</p>` : ""}
<p><a href="${e(d.invoicesUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Le mie fatture</a></p>
<p style="color:#71717a">Il team Transigo</p>
</body></html>`;
  return { subject, html, text };
}
