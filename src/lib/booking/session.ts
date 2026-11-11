// Who is using a booking wizard (D8, D70, D80) — computed on the server from the account context, shared by
// the Trasporto and Facchinaggio wizards. Pure: no personal data beyond the first name for the greeting.
import type { AccountContext } from "../auth/routing";

export type WizardSession =
  | { kind: "anonymous" }
  | { kind: "customer"; customerType: "private" | "business"; firstName: string | null }
  | { kind: "incomplete" } // D80
  | { kind: "other_role"; role: "padroncino" | "admin" }
  | { kind: "blocked" };

export function toWizardSession(ctx: AccountContext): WizardSession {
  if (ctx.state !== "signed_in") return { kind: "anonymous" };
  if (ctx.isBlocked) return { kind: "blocked" };
  if (ctx.role !== "cliente") return { kind: "other_role", role: ctx.role };
  if (ctx.customerProfile !== "complete" || !ctx.customerType) return { kind: "incomplete" };
  return { kind: "customer", customerType: ctx.customerType, firstName: ctx.firstName };
}

/** Error of the "Account" step, or null when the customer may continue. */
export function accountStepError(session: WizardSession): string | null {
  switch (session.kind) {
    case "customer":
      return null;
    case "anonymous":
      return "Accedi o registrati per continuare.";
    case "incomplete":
      return "Completa il tuo profilo per continuare.";
    case "other_role":
      return "Hai effettuato l'accesso con un account che non è un account cliente. Esci e accedi come cliente.";
    case "blocked":
      return "Il tuo account è sospeso.";
  }
}
