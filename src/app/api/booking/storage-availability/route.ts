import { NextResponse } from "next/server";
import { z } from "zod";
import { getAccountContext } from "@/lib/auth/session";
import { storageErrorMessage, storageErrorStep } from "@/lib/booking/storage/messages";
import { storageAvailability } from "@/lib/booking/storage/server";
import { storageStateSchema } from "@/lib/booking/storage/state";
import { createServiceClient } from "@/lib/supabase/service";

// Live availability of the "Periodo" step (D156): is a box of this size / are this many pallet places free for the
// whole period? Only yes / no leaves the server — never the capacity or the number of free units.
// TODO before production: rate limiting per IP (public endpoint).
const bodySchema = z.object({ state: storageStateSchema });

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: "Richiesta non valida.", step: "periodo" }, { status: 400 });
  const ctx = await getAccountContext();
  const customerType = ctx.state === "signed_in" && ctx.role === "cliente" && !ctx.isBlocked && ctx.customerType ? ctx.customerType : parsed.data.state.customerTypeView;
  try {
    const r = await storageAvailability(createServiceClient(), parsed.data.state, customerType);
    if (!r.ok) return NextResponse.json({ ok: false, message: storageErrorMessage(r.error, { minLeadHours: 0 }), step: storageErrorStep(r.error) });
    return NextResponse.json({ ok: true, available: r.available });
  } catch (e) {
    console.error("[booking] storage availability:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, message: "Non riusciamo a verificare la disponibilità. Riprova tra poco.", step: "periodo" }, { status: 503 });
  }
}
