import { NextResponse } from "next/server";
import { z } from "zod";
import { getAccountContext } from "@/lib/auth/session";
import { storageErrorMessage, storageErrorStep } from "@/lib/booking/storage/messages";
import { loadStorageOptions, quoteStorage } from "@/lib/booking/storage/server";
import { storageStateSchema } from "@/lib/booking/storage/state";
import { createServiceClient } from "@/lib/supabase/service";

// Live quote of the Deposito wizard (D158; works without login, D8). Same rules as /api/booking/quote: a route
// handler (re-quoted often), price only on the server (D76), customer amounts only in the response.
// TODO before production: rate limiting per IP (public endpoint that calls Google and writes quotes).
const bodySchema = z.object({ state: storageStateSchema });

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: { code: "incomplete" }, message: "Richiesta non valida.", step: "unita" }, { status: 400 });
  }
  const { state } = parsed.data;

  // Signed-in customers always get the price for their account type (D3, D154); others use the toggle.
  const ctx = await getAccountContext();
  const signedInCustomer = ctx.state === "signed_in" && ctx.role === "cliente" && !ctx.isBlocked && ctx.customerType ? ctx : null;
  const customerType = signedInCustomer?.customerType ?? state.customerTypeView;
  const ownerId = signedInCustomer?.userId ?? null; // D76

  const db = createServiceClient();
  try {
    const { outcome } = await quoteStorage(db, state, customerType, new Date(), ownerId);
    if (!outcome.ok) {
      const options = await loadStorageOptions(db);
      return NextResponse.json({ ...outcome, customerType, message: storageErrorMessage(outcome.error, { minLeadHours: options.minLeadHours }), step: storageErrorStep(outcome.error) });
    }
    return NextResponse.json({ ...outcome, customerType });
  } catch (e) {
    console.error("[booking] storage quote:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, error: { code: "pricing_unavailable" }, message: "Il calcolo del prezzo non è disponibile in questo momento. Riprova tra poco.", step: "preventivo" },
      { status: 503 },
    );
  }
}
