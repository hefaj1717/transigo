import { escapeHtml, type RenderedEmail } from "./common";

// E-mails to a carrier about admin decisions (D101, D113, D115). Sent through the outbox (D93) to the carrier's
// own address. Content: company name, the decision, the admin's reason where there is one, a link to the app.
// No VAT number, addresses or phone numbers.

export const CARRIER_APPROVED_TEMPLATE = "carrier_approved";
export const CARRIER_REJECTED_TEMPLATE = "carrier_rejected";
export const CARRIER_DOCUMENT_REJECTED_TEMPLATE = "carrier_document_rejected";
export const CARRIER_SUSPENDED_TEMPLATE = "carrier_suspended";
export const CARRIER_REACTIVATED_TEMPLATE = "carrier_reactivated";

type Base = { companyName: string; appUrl: string };

/** Plain text and HTML from the same paragraphs; `reason` is shown as a quoted block. */
function render(subject: string, paragraphs: string[], button: { label: string; url: string }, reason?: string): RenderedEmail {
  const text = [
    "Ciao,",
    "",
    ...paragraphs.flatMap((p) => [p, ""]),
    ...(reason ? ["Motivo:", reason, ""] : []),
    `${button.label}: ${button.url}`,
    "",
    "Transigo",
  ].join("\n");

  const e = escapeHtml;
  const reasonHtml = reason
    ? `<p style="margin:16px 0 4px;color:#71717a">Motivo</p><blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #d4d4d8;white-space:pre-line">${e(reason)}</blockquote>`
    : "";
  const html = `<!doctype html>
<html lang="it"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>Ciao,</p>
${paragraphs.map((p) => `<p>${e(p)}</p>`).join("\n")}
${reasonHtml}
<p><a href="${e(button.url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${e(button.label)}</a></p>
<p style="color:#71717a">Transigo</p>
</body></html>`;
  return { subject, html, text };
}

const home = (appUrl: string) => `${appUrl}/padroncino`;

export function renderCarrierApprovedEmail(d: Base): RenderedEmail {
  return render(
    "Il tuo account Transigo è attivo",
    [`l'account di ${d.companyName} è stato verificato e approvato.`, "Presto potrai vedere e accettare le corse nell'app."],
    { label: "Apri l'app", url: home(d.appUrl) },
  );
}

export function renderCarrierRejectedEmail(d: Base & { reason: string }): RenderedEmail {
  return render(
    "Registrazione Transigo: servono correzioni",
    [`la verifica dell'account di ${d.companyName} non è andata a buon fine.`, "Correggi i dati indicati e invia di nuovo la registrazione per la verifica."],
    { label: "Correggi la registrazione", url: home(d.appUrl) },
    d.reason,
  );
}

export function renderCarrierDocumentRejectedEmail(
  d: Base & { documentLabel: string; plate: string | null; reason: string; documentUrl: string },
): RenderedEmail {
  const what = d.plate ? `${d.documentLabel} del veicolo ${d.plate}` : d.documentLabel;
  return render(
    `Documento rifiutato: ${what}`,
    [`il documento «${what}» caricato da ${d.companyName} è stato rifiutato.`, "Carica un nuovo documento valido."],
    { label: "Carica un nuovo documento", url: d.documentUrl },
    d.reason,
  );
}

export function renderCarrierSuspendedEmail(d: Base & { reason: string }): RenderedEmail {
  return render(
    "Account Transigo sospeso",
    [
      `l'account di ${d.companyName} è stato sospeso: finché resta sospeso non potrai accettare nuove corse.`,
      "Le corse già accettate restano tue. Se ti chiediamo documenti aggiornati, caricali nell'app: dopo la verifica riattiveremo l'account.",
    ],
    { label: "Apri l'app", url: home(d.appUrl) },
    d.reason,
  );
}

export function renderCarrierReactivatedEmail(d: Base): RenderedEmail {
  return render(
    "Account Transigo riattivato",
    [`l'account di ${d.companyName} è di nuovo attivo.`],
    { label: "Apri l'app", url: home(d.appUrl) },
  );
}
