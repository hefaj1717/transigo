import { MapsError, type AddressSuggestion, type MapsProvider, type PlaceDetails, type RoutePoint } from "./types";

// Google Maps Platform implementation: Routes API (computeRoutes) and Places API (New).
// The API key is injected by the server-only factory (./index.ts) and is only ever sent in the
// X-Goog-Api-Key header — never in URLs, logs or error messages.

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const PLACES_URL = "https://places.googleapis.com/v1";
const DEFAULT_TIMEOUT_MS = 8000;

export type GoogleMapsOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  regionCodes?: string[]; // D61: Italy only
};

type GoogleAddressComponent = { longText?: string; shortText?: string; types?: string[] };

function toWaypoint(point: RoutePoint) {
  return "placeId" in point
    ? { placeId: point.placeId }
    : { location: { latLng: { latitude: point.lat, longitude: point.lng } } };
}

function errorFromStatus(status: number, what: string): MapsError {
  if (status === 400) return new MapsError("invalid_request", `${what}: invalid request`, status);
  if (status === 401 || status === 403) return new MapsError("unauthorized", `${what}: API key rejected or API not enabled`, status);
  if (status === 404) return new MapsError("not_found", `${what}: not found`, status);
  if (status === 429) return new MapsError("quota", `${what}: quota exceeded`, status);
  return new MapsError("unavailable", `${what}: provider error ${status}`, status);
}

export function createGoogleMapsProvider(options: GoogleMapsOptions): MapsProvider {
  const { apiKey } = options;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const regionCodes = options.regionCodes ?? ["it"];
  if (!apiKey) throw new MapsError("unauthorized", "Google Maps server API key is not configured");

  async function call<T>(what: string, url: string, init: RequestInit & { fieldMask: string }): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": init.fieldMask,
          ...(init.headers ?? {}),
        },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new MapsError("unavailable", `${what}: ${timedOut ? "timeout" : "network error"}`);
    }
    if (!res.ok) throw errorFromStatus(res.status, what);
    try {
      return (await res.json()) as T;
    } catch {
      throw new MapsError("unavailable", `${what}: invalid response`);
    }
  }

  return {
    async computeRoute(origin, destination) {
      const data = await call<{ routes?: { distanceMeters?: number; duration?: string }[] }>("computeRoute", ROUTES_URL, {
        method: "POST",
        fieldMask: "routes.distanceMeters,routes.duration",
        body: JSON.stringify({
          origin: toWaypoint(origin),
          destination: toWaypoint(destination),
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_UNAWARE", // D48: distance without traffic (cheaper SKU)
          units: "METRIC",
          languageCode: "it",
        }),
      });
      const route = data.routes?.[0];
      const distanceM = route?.distanceMeters;
      if (!route || typeof distanceM !== "number" || !Number.isSafeInteger(distanceM) || distanceM <= 0) {
        throw new MapsError("not_found", "computeRoute: no drivable route");
      }
      const durationS = Number.parseInt((route.duration ?? "0s").replace(/s$/, ""), 10);
      return { distanceM, durationS: Number.isFinite(durationS) ? durationS : 0 };
    },

    async autocomplete(input, sessionToken) {
      const text = input.trim();
      if (text.length < 3 || text.length > 200) throw new MapsError("invalid_request", "autocomplete: input must be 3–200 characters");
      type Prediction = { placeId?: string; text?: { text?: string }; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } } };
      const data = await call<{ suggestions?: { placePrediction?: Prediction }[] }>("autocomplete", `${PLACES_URL}/places:autocomplete`, {
        method: "POST",
        fieldMask: "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
        body: JSON.stringify({ input: text, sessionToken, includedRegionCodes: regionCodes, languageCode: "it", regionCode: "it" }),
      });
      return (data.suggestions ?? [])
        .map((s) => s.placePrediction)
        .filter((p): p is Prediction & { placeId: string } => !!p?.placeId)
        .map<AddressSuggestion>((p) => ({
          placeId: p.placeId,
          text: p.text?.text ?? "",
          mainText: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
          secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
        }));
    },

    async placeDetails(placeId, sessionToken) {
      if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) throw new MapsError("invalid_request", "placeDetails: invalid place id");
      const params = new URLSearchParams({ languageCode: "it", regionCode: "it" });
      if (sessionToken) params.set("sessionToken", sessionToken);
      const data = await call<{
        id?: string;
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
        addressComponents?: GoogleAddressComponent[];
      }>("placeDetails", `${PLACES_URL}/places/${encodeURIComponent(placeId)}?${params}`, {
        method: "GET",
        fieldMask: "id,formattedAddress,location,addressComponents",
      });
      const lat = data.location?.latitude;
      const lng = data.location?.longitude;
      if (typeof lat !== "number" || typeof lng !== "number") throw new MapsError("not_found", "placeDetails: place has no location");

      const components = data.addressComponents ?? [];
      const find = (type: string) => components.find((c) => c.types?.includes(type));
      const route = find("route")?.longText;
      const number = find("street_number")?.longText;
      const province = find("administrative_area_level_2")?.shortText?.toUpperCase();

      const details: PlaceDetails = {
        placeId: data.id ?? placeId,
        formattedAddress: data.formattedAddress ?? "",
        location: { lat, lng },
        street: route ? (number ? `${route}, ${number}` : route) : null,
        city: find("locality")?.longText ?? find("administrative_area_level_3")?.longText ?? null,
        postalCode: find("postal_code")?.longText ?? null,
        provinceCode: province && /^[A-Z]{2}$/.test(province) ? province : null,
        countryCode: find("country")?.shortText?.toUpperCase() ?? null,
      };
      return details;
    },
  };
}
