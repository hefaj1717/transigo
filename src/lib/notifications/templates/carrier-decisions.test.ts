import { describe, expect, it } from "vitest";
import {
  renderCarrierApprovedEmail,
  renderCarrierDocumentRejectedEmail,
  renderCarrierReactivatedEmail,
  renderCarrierRejectedEmail,
  renderCarrierSuspendedEmail,
} from "./carrier-decisions";

const base = { companyName: "Trasporti <Rossi> & C.", appUrl: "https://transigo.example" };
const reason = "Libretto <illeggibile>\nCarica una foto nitida.";

describe("carrier decision e-mails (D101, D113, D115)", () => {
  it("carrier_approved: company name escaped, link to the app", () => {
    const m = renderCarrierApprovedEmail(base);
    expect(m.subject).toBe("Il tuo account Transigo è attivo");
    expect(m.text).toContain("Trasporti <Rossi> & C.");
    expect(m.text).toContain("https://transigo.example/padroncino");
    expect(m.html).toContain("Trasporti &lt;Rossi&gt; &amp; C.");
    expect(m.html).not.toContain("<Rossi>");
    expect(m.text).not.toContain("Motivo");
  });

  it("carrier_rejected: the reason, escaped in HTML", () => {
    const m = renderCarrierRejectedEmail({ ...base, reason });
    expect(m.text).toContain(`Motivo:\n${reason}`);
    expect(m.html).toContain("Libretto &lt;illeggibile&gt;");
    expect(m.html).not.toContain("<illeggibile>");
    expect(m.text).toContain("invia di nuovo");
  });

  it("carrier_document_rejected: document, vehicle plate, reason and the link to the document", () => {
    const url = "https://transigo.example/padroncino/veicoli/v1#insurance_rca";
    const m = renderCarrierDocumentRejectedEmail({ ...base, documentLabel: "Assicurazione RCA", plate: "AB123CD", reason, documentUrl: url });
    expect(m.subject).toBe("Documento rifiutato: Assicurazione RCA del veicolo AB123CD");
    expect(m.text).toContain(`Motivo:\n${reason}`);
    expect(m.text).toContain(url);
    expect(m.html).toContain(url);
    expect(m.html).toContain("Libretto &lt;illeggibile&gt;");

    const company = renderCarrierDocumentRejectedEmail({ ...base, documentLabel: "Patente", plate: null, reason: "Scaduta", documentUrl: url });
    expect(company.subject).toBe("Documento rifiutato: Patente");
  });

  it("carrier_suspended: reason; already accepted jobs stay (D116)", () => {
    const m = renderCarrierSuspendedEmail({ ...base, reason: "RCA scaduta" });
    expect(m.subject).toBe("Account Transigo sospeso");
    expect(m.text).toContain("Motivo:\nRCA scaduta");
    expect(m.text).toContain("Le corse già accettate restano tue");
  });

  it("carrier_reactivated", () => {
    const m = renderCarrierReactivatedEmail(base);
    expect(m.subject).toBe("Account Transigo riattivato");
    expect(m.text).toContain("è di nuovo attivo");
  });
});
