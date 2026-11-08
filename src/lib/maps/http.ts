import { NextResponse } from "next/server";
import { MapsError } from "./types";

// Maps errors → HTTP responses with Italian user-facing messages. Provider details stay in server logs
// (without the API key, which never appears in MapsError messages).
const MESSAGES: Record<MapsError["code"], { status: number; message: string }> = {
  not_found: { status: 404, message: "Indirizzo o percorso non trovato." },
  invalid_request: { status: 400, message: "Richiesta non valida." },
  quota: { status: 503, message: "Servizio mappe momentaneamente sovraccarico. Riprova tra poco." },
  unauthorized: { status: 503, message: "Servizio mappe non disponibile." },
  unavailable: { status: 503, message: "Servizio mappe non disponibile. Riprova tra poco." },
};

export function mapsErrorResponse(error: unknown) {
  if (error instanceof MapsError) {
    if (error.code === "unauthorized" || error.code === "unavailable") {
      console.error(`[maps] ${error.code}: ${error.message}`);
    }
    const { status, message } = MESSAGES[error.code];
    return NextResponse.json({ error: error.code, message }, { status });
  }
  console.error("[maps] unexpected error", error instanceof Error ? error.message : error);
  return NextResponse.json({ error: "unavailable", message: MESSAGES.unavailable.message }, { status: 503 });
}
