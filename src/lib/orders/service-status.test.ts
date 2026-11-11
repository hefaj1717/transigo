import { describe, expect, it } from "vitest";
import { carrierJobStatusLabel } from "../carriers/jobs";
import { customerStatusLabel, progressSteps } from "./customer-view";
import { nextStatusFor } from "./dispatch";
import { orderStatusLabel } from "./status";

// Status words per service (D165): Facchinaggio goes assigned → picked_up → delivered, never in_transit.

describe("status labels per service", () => {
  it("admin: Lavoro iniziato / concluso for porters, transport unchanged", () => {
    expect(orderStatusLabel("picked_up", "porters")).toBe("Lavoro iniziato");
    expect(orderStatusLabel("delivered", "porters")).toBe("Lavoro concluso");
    expect(orderStatusLabel("paid", "porters")).toBe("Pagato");
    expect(orderStatusLabel("picked_up", "transport")).toBe("Ritirato");
    expect(orderStatusLabel("delivered", null)).toBe("Consegnato");
    expect(orderStatusLabel("unknown_x", "porters")).toBe("unknown_x");
  });

  it("customer and carrier wording", () => {
    expect(customerStatusLabel("assigned", "porters")).toBe("Facchini assegnati");
    expect(customerStatusLabel("assigned", "transport")).toBe("Trasportatore assegnato");
    expect(customerStatusLabel("completed", "porters")).toBe("Lavoro concluso");
    expect(customerStatusLabel("paid", "porters")).toBe("Confermato");
    expect(carrierJobStatusLabel("assigned", "porters")).toBe("Da iniziare");
    expect(carrierJobStatusLabel("picked_up", "porters")).toBe("Lavoro iniziato");
    expect(carrierJobStatusLabel("picked_up", "transport")).toBe("Ritirata");
  });

  it("admin next step: porters skip in_transit; storage has none", () => {
    expect(nextStatusFor("assigned", "porters")).toEqual({ to: "picked_up", label: "Segna lavoro iniziato" });
    expect(nextStatusFor("picked_up", "porters")).toEqual({ to: "delivered", label: "Segna lavoro concluso" });
    expect(nextStatusFor("in_transit", "porters")).toBeUndefined();
    expect(nextStatusFor("picked_up", "transport")?.to).toBe("in_transit");
    expect(nextStatusFor("assigned", "storage")).toBeUndefined();
  });

  it("customer progress bar: four steps for porters", () => {
    const base = { paid_at: "2026-11-10T08:00:00Z", assigned_at: "2026-11-10T09:00:00Z", picked_up_at: "2026-11-11T09:00:00Z", in_transit_at: null, delivered_at: null };
    const p = progressSteps({ ...base, status: "picked_up" }, "porters")!;
    expect(p.map((s) => [s.label, s.state])).toEqual([
      ["Confermato", "done"], ["Facchini assegnati", "done"], ["Lavoro iniziato", "current"], ["Lavoro concluso", "todo"],
    ]);
    expect(progressSteps({ ...base, status: "in_transit" }, "porters")).toBeNull();
    expect(progressSteps({ ...base, status: "picked_up" })!.map((s) => s.key)).toContain("in_transit");
  });
});
