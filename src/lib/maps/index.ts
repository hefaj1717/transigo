import "server-only";
import { createGoogleMapsProvider } from "./google";
import type { MapsProvider } from "./types";

export * from "./types";

let provider: MapsProvider | null = null;

/**
 * Server-side maps provider. Reads GOOGLE_MAPS_SERVER_API_KEY (never NEXT_PUBLIC_*), so it can only be
 * used in route handlers, server actions and server components ("server-only" breaks client bundles).
 */
export function getMapsProvider(): MapsProvider {
  if (!provider) {
    provider = createGoogleMapsProvider({ apiKey: process.env.GOOGLE_MAPS_SERVER_API_KEY ?? "" });
  }
  return provider;
}
