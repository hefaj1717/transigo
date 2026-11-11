"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { requireArea } from "@/lib/auth/session";
import { cancellationDeps, cancelOrderForCustomer } from "@/lib/orders/cancellation-server";
import { cancelUnpaidOrder, startCheckout } from "@/lib/payments/server";
import { getAppUrl } from "@/lib/supabase/env";
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

const reasonSchema = z.string().trim().max(2000);

/**
 * D33, D137: cancels a paid order (free / with the fee, automatic refund) or, when a carrier has the job, sends the
 * request to the admin. The amounts are computed by the database; the customer id comes from the session only.
 */
export async function cancelPaid(_prev: OrderActionState, formData: FormData): Promise<OrderActionState> {
  const id = orderId.safeParse(formData.get("orderId"));
  if (!id.success) return { error: "Ordine non valido." };
  const ctx = await requireArea("cliente", `/cliente/ordini/${id.data}`);
  const reason = reasonSchema.safeParse(formData.get("reason") ?? "");
  if (!reason.success) return { error: "Il motivo può avere al massimo 2000 caratteri." };

  let outcome;
  try {
    const deps = cancellationDeps(createServiceClient(), {
      appUrl: getAppUrl(),
      adminEmail: process.env.ADMIN_NOTIFICATION_EMAIL?.trim() || null,
      defer: after,
    });
    outcome = await cancelOrderForCustomer(deps, ctx.userId, id.data, reason.data || null);
  } catch (e) {
    console.error("[orders] cancelPaid:", e instanceof Error ? e.message : e);
    return { error: "Non è stato possibile annullare l'ordine. Riprova tra qualche minuto." };
  }
  if (!outcome.ok) return { error: outcome.message };
  redirect(`/cliente/ordini/${id.data}`);
}
