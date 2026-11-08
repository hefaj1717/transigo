import { NextResponse } from "next/server";
import { z } from "zod";
import { getMapsProvider } from "@/lib/maps";
import { mapsErrorResponse } from "@/lib/maps/http";

// Address autocomplete for the booking wizard (works without login). Proxies Places API (New) with the
// server key, Italy only (D61). The browser sends a Places session token (UUID) so that autocomplete +
// place details are billed as one session.
// TODO before production: rate limiting per IP (the endpoint is public).
const bodySchema = z.object({
  input: z.string().trim().min(3).max(200),
  sessionToken: z.uuid(),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", message: "Richiesta non valida." }, { status: 400 });
  }
  try {
    const suggestions = await getMapsProvider().autocomplete(parsed.data.input, parsed.data.sessionToken);
    return NextResponse.json({ suggestions });
  } catch (e) {
    return mapsErrorResponse(e);
  }
}
