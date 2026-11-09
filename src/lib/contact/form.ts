// Contact form (D125): validation and messages. Pure — used by the Server Action and its tests.
import { z } from "zod";

export const CONTACT_MSG = {
  sent: "Grazie! Abbiamo ricevuto il tuo messaggio e ti risponderemo al più presto all'indirizzo indicato.",
  rateLimited: "Hai inviato troppe richieste. Riprova più tardi.",
  invalid: "Controlla i campi evidenziati.",
  generic: "Invio non riuscito. Riprova tra qualche minuto.",
} as const;

/** Honeypot field: hidden from people, bots fill it. Its name looks like a real field on purpose. */
export const HONEYPOT_FIELD = "website";

export const contactFormSchema = z.object({
  name: z.string().trim().min(1, { error: "Inserisci il tuo nome." }).max(200, { error: "Massimo 200 caratteri." }),
  email: z.string().trim().max(320, { error: "Indirizzo troppo lungo." }).pipe(z.email({ error: "Indirizzo e-mail non valido." })),
  phone: z
    .string()
    .trim()
    .max(40, { error: "Massimo 40 caratteri." })
    .refine((v) => v === "" || /^[+0-9 ()./-]{5,40}$/.test(v), { error: "Numero di telefono non valido." }),
  message: z.string().trim().min(10, { error: "Scrivi almeno 10 caratteri." }).max(5000, { error: "Massimo 5000 caratteri." }),
  privacy: z.literal("on", { error: "Per inviare la richiesta devi accettare l'informativa sulla privacy." }),
});

export type ContactFormInput = z.output<typeof contactFormSchema>;
export type ContactField = keyof ContactFormInput;

export type ContactFormState = {
  status: "idle" | "sent" | "error";
  message?: string;
  fieldErrors?: Partial<Record<ContactField, string>>;
  /** Values to show again after an error (never after success). */
  values?: Partial<Record<Exclude<ContactField, "privacy">, string>>;
};

export const initialContactState: ContactFormState = { status: "idle" };

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

export type ParsedContactForm =
  | { kind: "bot" }
  | { kind: "invalid"; state: ContactFormState }
  | { kind: "ok"; input: ContactFormInput };

/** Reads the form: honeypot first, then the schema. */
export function parseContactForm(fd: FormData): ParsedContactForm {
  if (str(fd, HONEYPOT_FIELD).trim() !== "") return { kind: "bot" };
  const raw = { name: str(fd, "name"), email: str(fd, "email"), phone: str(fd, "phone"), message: str(fd, "message"), privacy: str(fd, "privacy") };
  const parsed = contactFormSchema.safeParse(raw);
  if (parsed.success) return { kind: "ok", input: parsed.data };
  const fieldErrors: Partial<Record<ContactField, string>> = {};
  for (const issue of parsed.error.issues) {
    const k = issue.path[0] as ContactField;
    fieldErrors[k] ??= issue.message;
  }
  return {
    kind: "invalid",
    state: { status: "error", message: CONTACT_MSG.invalid, fieldErrors, values: { name: raw.name, email: raw.email, phone: raw.phone, message: raw.message } },
  };
}
