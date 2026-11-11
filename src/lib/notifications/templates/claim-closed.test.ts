import { describe, expect, it } from "vitest";
import { renderClaimClosedEmail } from "./claim-closed";

const base = { firstName: "Giulia", orderNumber: "TG-2026-000020", category: "damaged_goods" as const, note: "Rimborsati 20 €.\nCi scusiamo.", claimsUrl: "https://app.example/cliente/reclami" };

describe("claim closed e-mail (Italian)", () => {
  it("order, category, the team's note and the link", () => {
    const m = renderClaimClosedEmail(base);
    expect(m.subject).toBe("Il tuo reclamo è stato chiuso – ordine TG-2026-000020");
    expect(m.text).toContain("Ciao Giulia,");
    expect(m.text).toContain("(Merce danneggiata)");
    expect(m.text).toContain("Rimborsati 20 €.\nCi scusiamo.");
    expect(m.text).toContain("https://app.example/cliente/reclami");
  });

  it("escapes the note in HTML; generic greeting without a name", () => {
    const m = renderClaimClosedEmail({ ...base, firstName: null, note: "<b>ok</b> & grazie" });
    expect(m.html).toContain("&lt;b&gt;ok&lt;/b&gt; &amp; grazie");
    expect(m.html).not.toContain("<b>ok</b>");
    expect(m.text.startsWith("Ciao,")).toBe(true);
  });
});
