import { NextResponse } from "next/server";
import { z } from "zod";
import { getAccountContext } from "@/lib/auth/session";
import { bookingErrorMessage, bookingErrorStep } from "@/lib/booking/messages";
import { loadBookingOptions, quoteBooking } from "@/lib/booking/server";
import { wizardStateSchema, type WizardState } from "@/lib/booking/state";
import { createServiceClient } from "@/lib/supabase/service";

// Live quote for the booking wizard (works without login, D8). A route handler, not a Server Action:
// Server Actions run one at a time per client and the wizard re-quotes often.
// The price is computed only here (D76); the response carries customer amounts only (toPublicQuote).
// TODO before production: rate limiting per IP (public endpoint that calls Google and writes quotes).
// probe: true = step "Percorso" — only the service area and route length are checked, with a placeholder
// date two weeks ahead (no vehicle, services or stored quote).
const bodySchema = z.object({ state: wizardStateSchema, probe: z.boolean().optional() });

function probeState(state: WizardState): WizardState {
  const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  return { ...state, pickupDate: inTwoWeeks, pickupWindow: "10-12", vehicleTypeId: null, portersPickup: null, portersDelivery: null, packingItems: 0, storage: null };
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: { code: "invalid_input" }, message: "Richiesta non valida.", step: "percorso" }, { status: 400 });
  }
  const state = parsed.data.probe ? probeState(parsed.data.state) : parsed.data.state;

  // Signed-in customers always get the price for their account type (D3); others use the toggle.
  const ctx = await getAccountContext();
  const signedInCustomer = ctx.state === "signed_in" && ctx.role === "cliente" && !ctx.isBlocked && ctx.customerType ? ctx : null;
  const customerType = signedInCustomer?.customerType ?? state.customerTypeView;
  const ownerId = signedInCustomer?.userId ?? null; // D76: only this customer can order with the stored quote

  const db = createServiceClient();
  try {
    const { outcome } = await quoteBooking(db, state, customerType, new Date(), ownerId);
    if (!outcome.ok) {
      const options = await loadBookingOptions(db);
      return NextResponse.json({
        ...outcome,
        customerType,
        message: bookingErrorMessage(outcome.error, { maxDistanceKm: options.maxDistanceKm, minLeadHours: options.minLeadHours }),
        step: bookingErrorStep(outcome.error),
      });
    }
    return NextResponse.json({ ...outcome, customerType });
  } catch (e) {
    console.error("[booking] quote:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, error: { code: "pricing_unavailable" }, message: "Il calcolo del prezzo non è disponibile in questo momento. Riprova tra poco.", step: "preventivo" },
      { status: 503 },
    );
  }
}
