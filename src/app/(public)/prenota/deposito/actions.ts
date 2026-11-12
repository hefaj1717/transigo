"use server";

import { completeProfileUrl, PATHS } from "@/lib/auth/routing";
import { getAccountContext } from "@/lib/auth/session";
import { placeStorageOrder, type StorageSubmitResult } from "@/lib/booking/storage/place-order";
import { quoteStorage } from "@/lib/booking/storage/server";
import { STORAGE_WIZARD_PATH } from "@/lib/booking/storage/state";
import { startCheckout } from "@/lib/payments/server";
import { createServiceClient } from "@/lib/supabase/service";

// Saving a Deposito order (and its chain, D153): session checks here (DAL), the order logic in placeStorageOrder()
// (src/lib/booking/storage/place-order.ts), then straight to Stripe Checkout for the whole group (one payment).

export type { StorageSubmitResult };

export async function submitStorageBooking(raw: unknown): Promise<StorageSubmitResult> {
  const ctx = await getAccountContext();
  if (ctx.state !== "signed_in") return { status: "redirect", to: `${PATHS.signIn}?next=${encodeURIComponent(`${STORAGE_WIZARD_PATH}?passo=account`)}` };
  if (ctx.isBlocked) return { status: "redirect", to: PATHS.suspended };
  if (ctx.role !== "cliente") return { status: "error", message: "Solo i clienti possono prenotare.", step: "account" };
  if (ctx.customerProfile !== "complete" || !ctx.customerType) return { status: "redirect", to: completeProfileUrl(`${STORAGE_WIZARD_PATH}?passo=riepilogo`) };

  const db = createServiceClient();
  const result = await placeStorageOrder({ db, now: new Date(), requote: quoteStorage }, { userId: ctx.userId, customerType: ctx.customerType }, raw);
  if (result.status !== "created") return result;

  // If Checkout fails, the order stays pending_payment and the customer pays from the order page (D88).
  try {
    const checkout = await startCheckout(db, { id: ctx.userId, email: ctx.email }, result.orderId);
    if (checkout.kind === "redirect") return { ...result, payment: { url: checkout.url } };
    return { ...result, payment: { error: checkout.kind === "not_payable" ? checkout.message : "Pagamento in verifica." } };
  } catch (e) {
    console.error("[booking] storage checkout:", e instanceof Error ? e.message : e);
    return { ...result, payment: { error: "Non è stato possibile avviare il pagamento. Puoi riprovare dalla pagina dell'ordine." } };
  }
}
