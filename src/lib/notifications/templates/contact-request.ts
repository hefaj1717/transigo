import { escapeHtml, type RenderedEmail } from "./common";

// "Nuova richiesta di contatto" e-mail to the Transigo team (D125). No personal data (name, e-mail, message):
// only the kind and a link — the request is read in /admin/richieste, so nothing personal stays in email_outbox.

export const CONTACT_REQUEST_TEMPLATE = "contact_request";

export type ContactRequestEmailData = { kind: "general" | "out_of_area"; requestId: string; adminUrl: string };

export function renderContactRequestEmail(d: ContactRequestEmailData): RenderedEmail {
  const what = d.kind === "out_of_area" ? "una richiesta da una zona non servita" : "una nuova richiesta dal modulo contatti";
  const subject = d.kind === "out_of_area" ? "Nuova richiesta da zona non servita" : "Nuova richiesta di contatto";
  const text = ["Ciao,", "", `è arrivata ${what}.`, "", `ID richiesta: ${d.requestId}`, "", `Apri la richiesta: ${d.adminUrl}`, "", "Transigo"].join("\n");
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="it"><body style="font-family:Arial,Helvetica,sans-serif;color:#18181b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>Ciao,</p>
<p>è arrivata ${e(what)}.</p>
<p style="color:#71717a">ID richiesta: ${e(d.requestId)}</p>
<p><a href="${e(d.adminUrl)}" style="display:inline-block;background:#1a2d5c;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Apri la richiesta</a></p>
<p style="color:#71717a">Transigo</p>
</body></html>`;
  return { subject, html, text };
}
