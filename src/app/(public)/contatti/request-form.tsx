"use client";

import { useSearchParams } from "next/navigation";
import { ContactForm } from "@/components/contact-form";
import type { PublicRates } from "@/lib/public/rates";
import { requestMessage } from "@/lib/public/requests";
import { sendContactAction } from "./actions";

/**
 * Contact form pre-filled from a Facchini / Deposito calculator (D162) until those wizards exist. Only values
 * that pass requestMessage() (known keys, numbers in range, existing box) reach the message.
 */
export function RequestContactForm({ rates }: { rates: PublicRates | null }) {
  const params = useSearchParams();
  const message = requestMessage(params, rates);
  return (
    <>
      {message ? (
        <p role="status" className="mb-6 rounded-md bg-accent-50 p-4 text-sm text-accent-900">
          <span className="font-semibold">Prenotazione online in arrivo.</span> Abbiamo inserito nel messaggio i dati che hai scelto: aggiungi indirizzo e data e ti ricontattiamo con la conferma del prezzo.
        </p>
      ) : null}
      <ContactForm key={message ?? ""} action={sendContactAction} defaultMessage={message ?? undefined} />
    </>
  );
}
