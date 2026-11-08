"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireArea } from "@/lib/auth/session";
import { cancelUnpaidOrder, startCheckout } from "@/lib/payments/server";
import { createServiceClient } from "@/lib/supabase/service";

// Customer actions on an unpaid order. The customer id comes from the verified session (DAL); the payment
// functions check that the order belongs to it. Status "paid" is never set here (only the Stripe webhook).

export type OrderActionState = { error?: string; message?: string };

const orderId = z.uuid();

/** "Paga ora": reopens the open Checkout session or creates one (D88). */
export async function payNow(_prev: OrderActionState, formData: FormData): Promise<OrderActionState> {
  const id = orderId.safeParse(formData.get("orderId"));
  if (!id.success) return { error: "Ordine non valido." };
  const ctx = await requireArea("cliente", `/cliente/ordini/${id.data}`);

  let url: string;
  try {
    const result = await startCheckout(createServiceClient(), { id: ctx.userId, email: ctx.email }, id.data);
    if (result.kind === "processing") return { message: "Il pagamento è in corso di verifica. Aggiorna la pagina tra qualche istante." };
    if (result.kind === "not_payable") return { error: result.message };
    url = result.url;
  } catch (e) {
    console.error("[orders] payNow:", e instanceof Error ? e.message : e);
    return { error: "Non è stato possibile avviare il pagamento. Riprova tra qualche minuto." };
  }
  redirect(url); // outside try/catch: redirect() throws
}

/** D92: cancels an unpaid order (its Checkout session is closed first). */
export async function cancelUnpaid(_prev: OrderActionState, formData: FormData): Promise<OrderActionState> {
  const id = orderId.safeParse(formData.get("orderId"));
  if (!id.success) return { error: "Ordine non valido." };
  const ctx = await requireArea("cliente", `/cliente/ordini/${id.data}`);
  try {
    const result = await cancelUnpaidOrder(createServiceClient(), ctx.userId, id.data);
    if (!result.ok) return { error: result.message };
  } catch (e) {
    console.error("[orders] cancelUnpaid:", e instanceof Error ? e.message : e);
    return { error: "Non è stato possibile annullare l'ordine. Riprova." };
  }
  redirect(`/cliente/ordini/${id.data}`);
}
