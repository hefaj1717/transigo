import { escapeHtml, type RenderedEmail } from "./common";

// "Padroncino da verificare" e-mail to the Transigo team (D106, D110), sent only when
// submit_carrier_for_review() returned newly_submitted = true.
// Content limited by D110: company name, carrier id and a link — no VAT number, addresses or phone numbers.

export const CARRIER_SUBMITTED_TEMPLATE = "carrier_submitted";

export type CarrierSubmittedData = {
  companyName: string;
  carrierId: string;
  submittedAt: Date;
  /** The carrier had been rejected before and sent the account again. */
  resubmission: boolean;
  adminUrl: string;
};

const romeDateTime = (d: Date) =>
  d.toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function renderCarrierSubmittedEmail(d: CarrierSubmittedData): RenderedEmail {
  const what = d.resubmission ? "ha inviato di nuovo i dati per la verifica (dopo un rifiuto)" : "ha inviato i dati per la verifica";
  const subject = `${d.resubmission ? "Nuovo invio" : "Nuovo padroncino"} da verificare – ${d.companyName}`;
  const when = romeDateTime(d.submittedAt);

  const text = [
    "Ciao,",
    "",
    `il padroncino ${d.companyName} ${what}.`,
    "",
    `Inviato: ${when}`,
    `ID padroncino: ${d.carrierId}`,
    "",
    `Apri la verifica: ${d.adminUrl}`,
    "",
    "Transigo",
  ].join("\n");

  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="it"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>Ciao,</p>
<p>il padroncino <strong>${e(d.companyName)}</strong> ${e(what)}.</p>
<table style="border-collapse:collapse;margin:16px 0">
<tr><td style="padding:4px 12px 4px 0;color:#71717a">Inviato</td><td style="padding:4px 0">${e(when)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#71717a">ID padroncino</td><td style="padding:4px 0;font-family:monospace">${e(d.carrierId)}</td></tr>
</table>
<p><a href="${e(d.adminUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Apri la verifica</a></p>
<p style="color:#71717a">Transigo</p>
</body></html>`;

  return { subject, html, text };
}
