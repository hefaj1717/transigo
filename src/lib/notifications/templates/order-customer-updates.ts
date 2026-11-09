import { escapeHtml, type RenderedEmail } from "./common";

// Customer e-mails after a dispatch change (spec 13): "Trasportatore assegnato" and "Ordine consegnato".
// Pure: the caller loads the data. Carrier data limited as in the customer panel — first name, company,
// vehicle type and plate (no phone, no amounts for the carrier).

export const ORDER_ASSIGNED_TEMPLATE = "order_assigned";
export const ORDER_DELIVERED_TEMPLATE = "order_delivered";

const romeDate = (d: Date) => d.toLocaleDateString("it-IT", { timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "long" });
const romeTime = (d: Date) => d.toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });

type Base = { firstName: string | null; orderNumber: string; pickupCity: string; deliveryCity: string; orderUrl: string };

export type OrderAssignedData = Base & {
  carrierFirstName: string | null;
  carrierCompany: string;
  vehicleType: string | null;
  plate: string | null;
  pickupWindowStart: Date;
  pickupWindowEnd: Date;
};

export type OrderDeliveredData = Base & { deliveredAt: Date };

function render(subject: string, greeting: string, intro: string, rows: [string, string][], outro: string, url: string): RenderedEmail {
  const text = [greeting, "", intro, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", outro, "", `Dettagli dell'ordine: ${url}`, "", "Il team Transigo"].join("\n");
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="it"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>${e(greeting)}</p>
<p>${e(intro)}</p>
<table style="border-collapse:collapse;margin:16px 0">
${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#71717a">${e(k)}</td><td style="padding:4px 0">${e(v)}</td></tr>`).join("\n")}
</table>
<p>${e(outro)}</p>
<p><a href="${e(url)}" style="display:inline-block;background:#1a2d5c;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Vedi l'ordine</a></p>
<p style="color:#71717a">Il team Transigo</p>
</body></html>`;
  return { subject, html, text };
}

export function renderOrderAssignedEmail(d: OrderAssignedData): RenderedEmail {
  const who = d.carrierFirstName ? `${d.carrierFirstName} (${d.carrierCompany})` : d.carrierCompany;
  const vehicle = [d.vehicleType, d.plate ? `targa ${d.plate}` : null].filter(Boolean).join(", ");
  const rows: [string, string][] = [
    ["Percorso", `${d.pickupCity} → ${d.deliveryCity}`],
    ["Ritiro", `${romeDate(d.pickupWindowStart)}, tra le ${romeTime(d.pickupWindowStart)} e le ${romeTime(d.pickupWindowEnd)}`],
    ["Trasportatore", who],
    ...(vehicle ? ([["Veicolo", vehicle]] as [string, string][]) : []),
  ];
  return render(
    `Trasportatore assegnato – ordine ${d.orderNumber}`,
    d.firstName ? `Ciao ${d.firstName},` : "Ciao,",
    `il tuo ordine ${d.orderNumber} è stato preso in carico da un trasportatore verificato.`,
    rows,
    "Per qualsiasi necessità sul trasporto contattaci: siamo noi il tuo riferimento.",
    d.orderUrl,
  );
}

export function renderOrderDeliveredEmail(d: OrderDeliveredData): RenderedEmail {
  return render(
    `Ordine consegnato – ${d.orderNumber}`,
    d.firstName ? `Ciao ${d.firstName},` : "Ciao,",
    `il tuo ordine ${d.orderNumber} è stato consegnato. Grazie per aver scelto Transigo!`,
    [
      ["Percorso", `${d.pickupCity} → ${d.deliveryCity}`],
      ["Consegnato", `${romeDate(d.deliveredAt)}, ${romeTime(d.deliveredAt)}`],
    ],
    "Se qualcosa non va, rispondi dalla pagina dell'ordine o contattaci.",
    d.orderUrl,
  );
}
