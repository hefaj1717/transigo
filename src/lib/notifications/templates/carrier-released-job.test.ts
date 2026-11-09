import { describe, expect, it } from "vitest";
import { renderCarrierReleasedJobEmail } from "./carrier-released-job";

const data = {
  orderNumber: "TG-2026-000123",
  companyName: "Trasporti <Rossi> & C.",
  pickupWindowStart: new Date("2026-11-10T07:00:00Z"),
  pickupWindowEnd: new Date("2026-11-10T09:00:00Z"),
  assignedAt: new Date("2026-11-09T22:50:00Z"),
  releasedAt: new Date("2026-11-09T23:00:00Z"),
  adminOrderUrl: "https://transigo.example/admin/ordini/11111111-1111-4111-8111-111111111111",
};

describe("carrier_released_job e-mail (D121)", () => {
  it("order number, company, pickup window and times in Italy, admin link", () => {
    const m = renderCarrierReleasedJobEmail(data);
    expect(m.subject).toBe("Rinuncia alla corsa TG-2026-000123 – Trasporti <Rossi> & C.");
    expect(m.text).toContain("Ritiro previsto: martedì 10 novembre 2026, 08:00–10:00");
    expect(m.text).toContain("Accettata: 9 novembre 2026, 23:50");
    expect(m.text).toContain("Rinuncia: 10 novembre 2026, 00:00");
    expect(m.text).toContain(data.adminOrderUrl);
    expect(m.html).toContain("Trasporti &lt;Rossi&gt; &amp; C.");
    expect(m.html).not.toContain("<Rossi>");
  });

  it("without the acceptance time the row is left out", () => {
    const m = renderCarrierReleasedJobEmail({ ...data, assignedAt: null });
    expect(m.text).not.toContain("Accettata");
  });
});
