"use client";

import Link from "next/link";
import { useActionState } from "react";
import { HONEYPOT_FIELD, initialContactState, type ContactField, type ContactFormState } from "@/lib/contact/form";

type ContactAction = (prev: ContactFormState, fd: FormData) => Promise<ContactFormState>;

const input = "mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:ring-2 focus:ring-brand-500 aria-[invalid=true]:border-red-500";
const label = "block text-sm font-medium text-zinc-800";

/**
 * Contact form (D125) shared by /contatti and the wizard's "out of area" box. `hidden`: extra fields for the
 * action (e.g. place IDs); `idPrefix` keeps element ids unique.
 */
export function ContactForm({
  action: serverAction,
  hidden = {},
  idPrefix = "contact",
  messagePlaceholder,
  defaultMessage,
}: {
  action: ContactAction;
  hidden?: Record<string, string>;
  idPrefix?: string;
  messagePlaceholder?: string;
  /** Pre-filled message (e.g. from a home-page calculator); the values returned after an error win. */
  defaultMessage?: string;
}) {
  const [state, action, pending] = useActionState(serverAction, initialContactState);

  if (state.status === "sent") {
    return (
      <div role="status" className="rounded-xl border border-accent-200 bg-accent-50 p-6 text-accent-900">
        <h2 className="text-lg font-semibold">Messaggio inviato</h2>
        <p className="mt-2">{state.message}</p>
      </div>
    );
  }

  const err = (k: ContactField) => state.fieldErrors?.[k];
  const errId = (k: ContactField) => (err(k) ? `${idPrefix}-${k}-error` : undefined);
  // key: re-mount the inputs with the returned values after an error
  const key = JSON.stringify(state.values ?? {});

  return (
    <form action={action} noValidate className="space-y-5" key={key}>
      {state.status === "error" && state.message ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{state.message}</p> : null}

      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {/* Honeypot: invisible to people and screen readers, filled by bots. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor={`${idPrefix}-${HONEYPOT_FIELD}`}>Sito web</label>
        <input id={`${idPrefix}-${HONEYPOT_FIELD}`} name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-name`} className={label}>Nome e cognome <span className="text-red-600">*</span></label>
          <input id={`${idPrefix}-name`} name="name" autoComplete="name" defaultValue={state.values?.name} aria-invalid={!!err("name")} aria-describedby={errId("name")} className={input} />
          <FieldError p={idPrefix} k="name" msg={err("name")} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-email`} className={label}>E-mail <span className="text-red-600">*</span></label>
          <input id={`${idPrefix}-email`} name="email" type="email" autoComplete="email" defaultValue={state.values?.email} aria-invalid={!!err("email")} aria-describedby={errId("email")} className={input} />
          <FieldError p={idPrefix} k="email" msg={err("email")} />
        </div>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-phone`} className={label}>Telefono <span className="font-normal text-zinc-500">(facoltativo)</span></label>
        <input id={`${idPrefix}-phone`} name="phone" type="tel" autoComplete="tel" defaultValue={state.values?.phone} aria-invalid={!!err("phone")} aria-describedby={errId("phone")} className={`${input} sm:max-w-xs`} />
        <FieldError p={idPrefix} k="phone" msg={err("phone")} />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-message`} className={label}>Messaggio <span className="text-red-600">*</span></label>
        <textarea id={`${idPrefix}-message`} name="message" rows={6} placeholder={messagePlaceholder} maxLength={5000} defaultValue={state.values?.message ?? defaultMessage} aria-invalid={!!err("message")} aria-describedby={errId("message")} className={input} />
        <FieldError p={idPrefix} k="message" msg={err("message")} />
      </div>
      <div>
        <label className="flex items-start gap-3 text-sm text-zinc-700">
          <input type="checkbox" name="privacy" className="mt-1" aria-invalid={!!err("privacy")} aria-describedby={errId("privacy")} />
          <span>
            Ho letto l&apos;<Link href="/privacy" target="_blank" className="font-medium text-brand-700 underline">informativa sulla privacy</Link> e acconsento al trattamento dei miei dati per rispondere alla richiesta. <span className="text-red-600">*</span>
          </span>
        </label>
        <FieldError p={idPrefix} k="privacy" msg={err("privacy")} />
      </div>
      <button type="submit" disabled={pending} className="rounded-md bg-brand-800 px-6 py-3 font-semibold text-white hover:bg-brand-900 disabled:opacity-60">
        {pending ? "Invio in corso…" : "Invia messaggio"}
      </button>
    </form>
  );
}

function FieldError({ p, k, msg }: { p: string; k: ContactField; msg: string | undefined }) {
  return msg ? <p id={`${p}-${k}-error`} className="mt-1 text-sm text-red-600">{msg}</p> : null;
}
