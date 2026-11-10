import { escapeHtml, type RenderedEmail } from "./common";

// "Rinuncia alla corsa" e-mail to the Transigo team (D121), sent after a successful release_job().
// No customer data: order number, the carrier's company, pickup window, when the job was accepted and released,
// and the link to /admin/ordini/[id]. Every release sends one (keyed by order and release time, D129 — see jobs-server.ts).

export const CARRIER_RELEASED_JOB_TEMPLATE = "carrier_released_job";

export type CarrierReleasedJobData = {
  orderNumber: string;
  companyName: string;
  pickupWindowStart: Date;
  pickupWindowEnd: Date;
  /** When the carrier had accepted the job (null when unknown). */
  assignedAt: Date | null;
  releasedAt: Date;
  adminOrderUrl: string;
};

const TZ = "Europe/Rome";
const day = (d: Date) => d.toLocaleDateString("it-IT", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
const time = (d: Date) => d.toLocaleTimeString("it-IT", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const dateTime = (d: Date) => `${d.toLocaleDateString("it-IT", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" })}, ${time(d)}`;

export function renderCarrierReleasedJobEmail(d: CarrierReleasedJobData): RenderedEmail {
  const subject = `Rinuncia alla corsa ${d.orderNumber} – ${d.companyName}`;
  const pickup = `${day(d.pickupWindowStart)}, ${time(d.pickupWindowStart)}–${time(d.pickupWindowEnd)}`;
  const rows: [string, string][] = [
    ["Ordine", d.orderNumber],
    ["Padroncino", d.companyName],
    ["Ritiro previsto", pickup],
    ...(d.assignedAt ? ([["Accettata", dateTime(d.assignedAt)]] as [string, string][]) : []),
    ["Rinuncia", dateTime(d.releasedAt)],
  ];

  const text = [
    "Ciao,",
    "",
    `il padroncino ${d.companyName} ha rinunciato alla corsa ${d.orderNumber}.`,
    "La corsa è tornata nell'elenco delle corse disponibili.",
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    `Apri l'ordine: ${d.adminOrderUrl}`,
    "",
    "Transigo",
  ].join("\n");

  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="it"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>Ciao,</p>
<p>il padroncino <strong>${e(d.companyName)}</strong> ha rinunciato alla corsa <strong>${e(d.orderNumber)}</strong>.<br>La corsa è tornata nell'elenco delle corse disponibili.</p>
<table style="border-collapse:collapse;margin:16px 0">
${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#71717a">${e(k)}</td><td style="padding:4px 0">${e(v)}</td></tr>`).join("\n")}
</table>
<p><a href="${e(d.adminOrderUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Apri l'ordine</a></p>
<p style="color:#71717a">Transigo</p>
</body></html>`;

  return { subject, html, text };
}
