// Maps adapter contract (spec sections 2a, 3.1, 6). Implementations run on the server only;
// the server API key never reaches the browser.

export type LatLng = { lat: number; lng: number };
export type RoutePoint = { placeId: string } | LatLng;

export type RouteResult = {
  distanceM: number; // road distance (D48)
  durationS: number;
};

export type AddressSuggestion = {
  placeId: string;
  text: string; // full suggestion text
  mainText: string; // e.g. street and number
  secondaryText: string; // e.g. city, province
};

export type PlaceDetails = {
  placeId: string;
  formattedAddress: string;
  location: LatLng;
  street: string | null; // route + street number
  city: string | null;
  postalCode: string | null;
  provinceCode: string | null; // sigla, e.g. "MI" (administrative_area_level_2) — D13
  countryCode: string | null; // ISO 3166-1 alpha-2, e.g. "IT"
};

export type MapsErrorCode =
  | "not_found" // no route / unknown place
  | "invalid_request" // bad input
  | "quota" // rate limit or quota exceeded
  | "unauthorized" // key missing, restricted or API not enabled (configuration problem)
  | "unavailable"; // network error, timeout, provider 5xx

export class MapsError extends Error {
  constructor(
    public readonly code: MapsErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "MapsError";
  }
}

export interface MapsProvider {
  computeRoute(origin: RoutePoint, destination: RoutePoint): Promise<RouteResult>;
  autocomplete(input: string, sessionToken: string): Promise<AddressSuggestion[]>;
  placeDetails(placeId: string, sessionToken?: string): Promise<PlaceDetails>;
}
