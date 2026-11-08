import { NextResponse } from "next/server";
import { z } from "zod";
import { getMapsProvider } from "@/lib/maps";
import { mapsErrorResponse } from "@/lib/maps/http";

// Place details for a selected suggestion (address, coordinates, province for the service-area check).
// The province returned here is for display only: the quote endpoint (Stage 2b) resolves places and
// distances again on the server and never trusts values sent by the browser.
const bodySchema = z.object({
  placeId: z.string().regex(/^[A-Za-z0-9_-]{10,300}$/),
  sessionToken: z.uuid().optional(),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", message: "Richiesta non valida." }, { status: 400 });
  }
  try {
    const place = await getMapsProvider().placeDetails(parsed.data.placeId, parsed.data.sessionToken);
    if (place.countryCode !== "IT") {
      return NextResponse.json({ error: "not_found", message: "Serviamo solo indirizzi in Italia." }, { status: 422 });
    }
    return NextResponse.json({ place });
  } catch (e) {
    return mapsErrorResponse(e);
  }
}
