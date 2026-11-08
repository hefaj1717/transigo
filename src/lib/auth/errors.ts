// Maps Supabase Auth / Postgres errors to Italian UI messages.
// Codes: https://supabase.com/docs/guides/auth/debugging/error-codes

export const AUTH_MSG = {
  invalidCredentials: "E-mail o password non corretti",
  emailNotConfirmed: "Devi prima confermare il tuo indirizzo e-mail. Controlla la posta (anche lo spam).",
  emailTaken: "Esiste già un account con questa e-mail. Accedi oppure recupera la password.",
  vatTaken: "Questa partita IVA è già registrata. Contattaci se pensi si tratti di un errore.",
  weakPassword: "La password è troppo debole. Scegline una più lunga, con lettere e numeri.",
  samePassword: "La nuova password deve essere diversa da quella attuale.",
  rateLimited: "Troppi tentativi. Riprova tra qualche minuto.",
  linkInvalid: "Il link non è valido o è scaduto. Richiedine uno nuovo.",
  sessionMissing: "Sessione scaduta. Richiedi un nuovo link per reimpostare la password.",
  signupDisabled: "Le registrazioni sono momentaneamente disattivate.",
  generic: "Si è verificato un errore. Riprova più tardi.",
} as const;

type ErrorLike = { code?: string | null; message?: string; status?: number } | null | undefined;

/** Supabase Auth error → Italian message. Unknown errors get a generic message (details are logged by the caller). */
export function authErrorMessage(error: ErrorLike): string {
  switch (error?.code) {
    case "invalid_credentials":
      return AUTH_MSG.invalidCredentials;
    case "email_not_confirmed":
      return AUTH_MSG.emailNotConfirmed;
    case "user_already_exists":
    case "email_exists":
      return AUTH_MSG.emailTaken;
    case "weak_password":
      return AUTH_MSG.weakPassword;
    case "same_password":
      return AUTH_MSG.samePassword;
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
    case "over_sms_send_rate_limit":
      return AUTH_MSG.rateLimited;
    case "otp_expired":
    case "bad_jwt":
    case "flow_state_expired":
    case "flow_state_not_found":
      return AUTH_MSG.linkInvalid;
    case "session_not_found":
    case "session_expired":
      return AUTH_MSG.sessionMissing;
    case "signup_disabled":
    case "email_provider_disabled":
      return AUTH_MSG.signupDisabled;
  }
  if (error?.status === 429) return AUTH_MSG.rateLimited;
  return AUTH_MSG.generic;
}

/** Postgres unique violation on carriers.vat_number (constraint carriers_vat_number_key). */
export function isVatTakenError(error: ErrorLike): boolean {
  return error?.code === "23505" && (error.message ?? "").includes("vat_number");
}
