import type { FieldErrors } from "./schemas";

/** State returned by account Server Actions to forms using useActionState. */
export type FormState = {
  /** Per-field messages (key = input name); "_form" = message for the whole form. */
  errors?: FieldErrors;
  /** Success message (e.g. "e-mail sent"). */
  message?: string;
  /** Submitted values to refill the form after an error. Passwords are never returned. */
  values?: Record<string, string>;
  /** Sign-in only: the password was right but the e-mail is not confirmed yet → the form offers to resend the link. */
  emailNotConfirmed?: boolean;
};

export const initialFormState: FormState = {};

const NEVER_ECHO = new Set(["password", "passwordConfirm"]);

export function echoValues(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter(([k]) => !NEVER_ECHO.has(k) && !k.startsWith("$")));
}
