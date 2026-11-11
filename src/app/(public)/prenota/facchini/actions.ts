"use server";

import { completeProfileUrl, PATHS } from "@/lib/auth/routing";
import { getAccountContext } from "@/lib/auth/session";
import { placePortersOrder, type PortersSubmitResult } from "@/lib/booking/porters/place-order";
import { quotePorters } from "@/lib/booking/porters/server";
import { PORTERS_WIZARD_PATH } from "@/lib/booking/porters/state";
import { startCheckout } from "@/lib/payments/server";
import { createServiceClient } from "@/lib/supabase/service";

// Saving a Facchinaggio order: session checks here (DAL), the order logic in placePortersOrder()
// (src/lib/booking/porters/place-order.ts), then straight to Stripe Checkout as the transport wizard.

export type { PortersSubmitResult };

export async function submitPortersBooking(raw: unknown): Promise<PortersSubmitResult> {
  const ctx = await getAccountContext();
  if (ctx.state !== "signed_in") return { status: "redirect", to: `${PATHS.signIn}?next=${encodeURIComponent(`${PORTERS_WIZARD_PATH}?passo=account`)}` };
  if (ctx.isBlocked) return { status: "redirect", to: PATHS.suspended };
  if (ctx.role !== "cliente") return { status: "error", message: "Solo i clienti possono prenotare.", step: "account" };
  if (ctx.customerProfile !== "complete" || !ctx.customerType) return { status: "redirect", to: completeProfileUrl(`${PORTERS_WIZARD_PATH}?passo=riepilogo`) };

  const db = createServiceClient();
  const result = await placePortersOrder({ db, now: new Date(), requote: quotePorters }, { userId: ctx.userId, customerType: ctx.customerType }, raw);
  if (result.status !== "created") return result;

  // If Checkout fails, the order stays pending_payment and the customer pays from the order page (D88).
  try {
    const checkout = await startCheckout(db, { id: ctx.userId, email: ctx.email }, result.orderId);
    if (checkout.kind === "redirect") return { ...result, payment: { url: checkout.url } };
    return { ...result, payment: { error: checkout.kind === "not_payable" ? checkout.message : "Pagamento in verifica." } };
  } catch (e) {
    console.error("[booking] porters checkout:", e instanceof Error ? e.message : e);
    return { ...result, payment: { error: "Non è stato possibile avviare il pagamento. Puoi riprovare dalla pagina dell'ordine." } };
  }
}
