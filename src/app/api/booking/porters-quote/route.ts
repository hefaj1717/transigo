import { NextResponse } from "next/server";
import { z } from "zod";
import { getAccountContext } from "@/lib/auth/session";
import { portersErrorMessage, portersErrorStep } from "@/lib/booking/porters/messages";
import { loadPortersOptions, quotePorters } from "@/lib/booking/porters/server";
import { portersStateSchema } from "@/lib/booking/porters/state";
import { createServiceClient } from "@/lib/supabase/service";

// Live quote of the Facchinaggio wizard (D158; works without login, D8). Same rules as /api/booking/quote:
// a route handler (re-quoted often), price only on the server (D76), customer amounts only in the response.
// TODO before production: rate limiting per IP (public endpoint that calls Google and writes quotes).
// probe: true = step "Indirizzo" — only the address and the service area, with a placeholder date two weeks ahead.
const bodySchema = z.object({ state: portersStateSchema, probe: z.boolean().optional() });

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: { code: "invalid_input" }, message: "Richiesta non valida.", step: "indirizzo" }, { status: 400 });
  }
  const state = parsed.data.probe
    ? { ...parsed.data.state, date: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10), window: "10-12" as const }
    : parsed.data.state;

  // Signed-in customers always get the price for their account type (D3); before signing in the price is net + IVA
  // for everyone (D181) — after sign-in a private customer sees it with IVA.
  const ctx = await getAccountContext();
  const signedInCustomer = ctx.state === "signed_in" && ctx.role === "cliente" && !ctx.isBlocked && ctx.customerType ? ctx : null;
  const customerType = signedInCustomer?.customerType ?? "business";
  const ownerId = signedInCustomer?.userId ?? null; // D76

  const db = createServiceClient();
  try {
    const { outcome } = await quotePorters(db, state, customerType, new Date(), ownerId);
    if (!outcome.ok) {
      const options = await loadPortersOptions(db);
      const ctxMsg = { minLeadHours: options?.minLeadHours ?? 24, minPersons: options?.minPersons ?? 2, minHours: options?.minHours ?? 1 };
      return NextResponse.json({ ...outcome, customerType, message: portersErrorMessage(outcome.error, ctxMsg), step: portersErrorStep(outcome.error) });
    }
    return NextResponse.json({ ...outcome, customerType });
  } catch (e) {
    console.error("[booking] porters quote:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, error: { code: "pricing_unavailable" }, message: "Il calcolo del prezzo non è disponibile in questo momento. Riprova tra poco.", step: "preventivo" },
      { status: 503 },
    );
  }
}
