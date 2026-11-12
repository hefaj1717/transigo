import { describe, expect, it } from "vitest";
import type { AccountContext } from "../auth/routing";
import { accountStepError, initialWizardStep, toWizardSession, wizardSteps } from "./session";

const signedIn = (patch: Record<string, unknown> = {}) =>
  ({ state: "signed_in", userId: "u", email: "a@b.it", role: "cliente", isBlocked: false, firstName: "Anna", carrierStatus: null, customerProfile: "complete", customerType: "private", ...patch }) as unknown as AccountContext;

describe("toWizardSession / accountStepError (shared by the booking wizards)", () => {
  it("maps every account state", () => {
    expect(toWizardSession({ state: "anonymous" })).toEqual({ kind: "anonymous" });
    expect(toWizardSession(signedIn({ isBlocked: true }))).toEqual({ kind: "blocked" });
    expect(toWizardSession(signedIn({ role: "padroncino" }))).toEqual({ kind: "other_role", role: "padroncino" });
    expect(toWizardSession(signedIn({ customerProfile: "incomplete" }))).toEqual({ kind: "incomplete" });
    expect(toWizardSession(signedIn({ customerType: "business" }))).toEqual({ kind: "customer", customerType: "business", firstName: "Anna" });
  });

  it("only a complete customer passes the Account step", () => {
    expect(accountStepError({ kind: "customer", customerType: "private", firstName: null })).toBeNull();
    for (const s of [{ kind: "anonymous" }, { kind: "incomplete" }, { kind: "blocked" }, { kind: "other_role", role: "admin" }] as const) {
      expect(accountStepError(s)).toEqual(expect.any(String));
    }
  });

  it("the Account step is hidden for a signed-in customer only; ?passo=account then goes on to the next step", () => {
    const steps = [{ id: "data" }, { id: "account" }, { id: "contatti" }];
    const customer = { kind: "customer", customerType: "private", firstName: null } as const;
    expect(wizardSteps(steps, customer).map((s) => s.id)).toEqual(["data", "contatti"]);
    for (const s of [{ kind: "anonymous" }, { kind: "incomplete" }, { kind: "blocked" }, { kind: "other_role", role: "admin" }] as const) {
      expect(wizardSteps(steps, s).map((x) => x.id)).toEqual(["data", "account", "contatti"]);
      expect(initialWizardStep("account", s, "contatti")).toBe("account");
    }
    expect(initialWizardStep("account", customer, "contatti")).toBe("contatti");
    expect(initialWizardStep("data", customer, "contatti")).toBe("data");
    expect(initialWizardStep(null, customer, "contatti")).toBeNull();
  });
});
