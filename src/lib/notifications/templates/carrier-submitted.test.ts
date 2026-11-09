import { describe, expect, it } from "vitest";
import { renderCarrierSubmittedEmail } from "./carrier-submitted";

const data = {
  companyName: "Trasporti <Rossi> & C.",
  carrierId: "66666666-6666-4666-8666-666666666666",
  submittedAt: new Date("2026-11-09T23:30:00Z"),
  resubmission: false,
  adminUrl: "https://transigo.example/admin/padroncini",
};

describe("carrier_submitted e-mail (D110)", () => {
  it("company name, carrier id, date in Italy and the admin link", () => {
    const m = renderCarrierSubmittedEmail(data);
    expect(m.subject).toBe("Nuovo padroncino da verificare – Trasporti <Rossi> & C.");
    expect(m.text).toContain(data.carrierId);
    expect(m.text).toContain("10 novembre 2026");
    expect(m.text).toContain(data.adminUrl);
    expect(m.html).toContain("Trasporti &lt;Rossi&gt; &amp; C.");
    expect(m.html).not.toContain("<Rossi>");
  });
  it("a resubmission after a rejection says so", () => {
    const m = renderCarrierSubmittedEmail({ ...data, resubmission: true });
    expect(m.subject).toMatch(/^Nuovo invio da verificare/);
    expect(m.text).toContain("dopo un rifiuto");
  });
});
