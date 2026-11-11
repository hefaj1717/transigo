import { formatCents } from "@/lib/pricing/money";
import { startLabel, summaryLine, summaryRows, summaryWindow, type OrderSummary } from "@/lib/orders/order-summary";
import { escapeHtml, type RenderedEmail } from "./common";

// E-mails of the customer cancellation (D33, D137; plan docs/plany/panel-klienta-2.md, part A):
//   order_cancelled          → customer: cancelled, fee (if any) and the refund amount;
//   cancellation_requested   → Transigo team: a request on an assigned job waits for a decision — no customer data;
//   carrier_job_cancelled    → the assigned carrier: the customer asked to cancel, do not do the job.
// One e-mail per order and template (outbox key '' — D129).

export const ORDER_CANCELLED_TEMPLATE = "order_cancelled";
export const CANCELLATION_REQUESTED_TEMPLATE = "cancellation_requested";
export const CARRIER_JOB_CANCELLED_TEMPLATE = "carrier_job_cancelled";

const TZ = "Europe/Rome";
const day = (d: Date) => d.toLocaleDateString("it-IT", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
const time = (d: Date) => d.toLocaleTimeString("it-IT", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const window = (start: Date, end: Date) => `${day(start)}, ${time(start)}–${time(end)}`;

function layout(greeting: string, paragraphs: string[], rows: [string, string][], button: { label: string; url: string } | null): RenderedEmail["html"] {
  const e = escapeHtml;
  return `<!doctype html>
<html lang="it"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>${e(greeting)}</p>
${paragraphs.map((p) => `<p>${e(p)}</p>`).join("\n")}
<table style="border-collapse:collapse;margin:16px 0">
${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#71717a">${e(k)}</td><td style="padding:4px 0">${e(v)}</td></tr>`).join("\n")}
</table>
${button ? `<p><a href="${e(button.url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${e(button.label)}</a></p>` : ""}
<p style="color:#71717a">Transigo</p>
</body></html>`;
}

function text(greeting: string, paragraphs: string[], rows: [string, string][], button: { label: string; url: string } | null): string {
  return [greeting, "", ...paragraphs.flatMap((p) => [p, ""]), ...rows.map(([k, v]) => `${k}: ${v}`), "", ...(button ? [`${button.label}: ${button.url}`, ""] : []), "Transigo"].join("\n");
}

function render(subject: string, greeting: string, paragraphs: string[], rows: [string, string][], button: { label: string; url: string } | null): RenderedEmail {
  return { subject, html: layout(greeting, paragraphs, rows, button), text: text(greeting, paragraphs, rows, button) };
}

// ---------------------------------------------------------------------------

export type OrderCancelledData = {
  firstName: string | null;
  orderNumber: string;
  summary: OrderSummary;
  feeCents: number;
  refundCents: number;
  orderUrl: string;
};

export function renderOrderCancelledEmail(d: OrderCancelledData): RenderedEmail {
  const paragraphs = [
    `il tuo ordine ${d.orderNumber} (${summaryLine(d.summary)}) è stato annullato.`,
    d.refundCents > 0
      ? "Il rimborso viene inviato sulla carta usata per il pagamento: di solito arriva in 5–10 giorni lavorativi, a seconda della banca."
      : "Non è previsto alcun rimborso per questo ordine.",
  ];
  const rows: [string, string][] = [
    ["Ordine", d.orderNumber],
    ...(d.feeCents > 0 ? ([["Costo di annullamento", formatCents(d.feeCents)]] as [string, string][]) : []),
    ["Rimborso", formatCents(d.refundCents)],
  ];
  return render(`Ordine ${d.orderNumber} annullato`, `Ciao${d.firstName ? ` ${d.firstName}` : ""},`, paragraphs, rows, { label: "Vedi l'ordine", url: d.orderUrl });
}

// ---------------------------------------------------------------------------

export type CancellationRequestedData = {
  orderNumber: string;
  companyName: string | null;
  summary: OrderSummary;
  adminOrderUrl: string;
};

/** "Ritiro previsto" / "Inizio lavoro previsto" with the window; nothing for storage (no carrier, no window). */
function plannedStart(s: OrderSummary): [string, string][] {
  const w = summaryWindow(s);
  return w ? [[`${startLabel(s)} previsto`, window(w.start, w.end)]] : [];
}

export function renderCancellationRequestedEmail(d: CancellationRequestedData): RenderedEmail {
  const rows: [string, string][] = [
    ["Ordine", d.orderNumber],
    ...(d.companyName ? ([["Padroncino", d.companyName]] as [string, string][]) : []),
    ...plannedStart(d.summary),
  ];
  return render(
    `Richiesta di annullamento ${d.orderNumber}`,
    "Ciao,",
    [`il cliente ha chiesto di annullare l'ordine ${d.orderNumber}, già accettato da un padroncino.`, "Decidi il rimborso e l'eventuale importo per il padroncino."],
    rows,
    { label: "Apri l'ordine", url: d.adminOrderUrl },
  );
}

// ---------------------------------------------------------------------------

export type CarrierJobCancelledData = {
  firstName: string | null;
  orderNumber: string;
  summary: OrderSummary;
  jobUrl: string;
};

export function renderCarrierJobCancelledEmail(d: CarrierJobCancelledData): RenderedEmail {
  const rows: [string, string][] = [
    ["Corsa", d.orderNumber],
    ...summaryRows(d.summary).filter(([k]) => k !== "Ritiro" && k !== "Quando"),
    ...plannedStart(d.summary),
  ];
  return render(
    `Corsa ${d.orderNumber} annullata dal cliente`,
    `Ciao${d.firstName ? ` ${d.firstName}` : ""},`,
    [`il cliente ha annullato la corsa ${d.orderNumber}: non devi effettuarla.`, "Transigo ti contatterà se è previsto un importo per te."],
    rows,
    { label: "Vedi la corsa", url: d.jobUrl },
  );
}
