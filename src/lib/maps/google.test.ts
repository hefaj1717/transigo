import { describe, expect, it, vi } from "vitest";
import { createGoogleMapsProvider } from "./google";
import { MapsError } from "./types";

const KEY = "test-key-123";

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

async function expectMapsError(promise: Promise<unknown>, code: string) {
  const e = (await promise.catch((x: unknown) => x)) as MapsError;
  expect(e).toBeInstanceOf(MapsError);
  expect(e.code).toBe(code);
  expect(String(e.message)).not.toContain(KEY);
}

describe("computeRoute", () => {
  it("returns distance and duration; key only in the header", async () => {
    const fetch = mockFetch(200, { routes: [{ distanceMeters: 143_122, duration: "6498s" }] });
    const maps = createGoogleMapsProvider({ apiKey: KEY, fetch });
    await expect(maps.computeRoute({ placeId: "ChIJ-milano-000" }, { lat: 45.07, lng: 7.68 })).resolves.toEqual({ distanceM: 143_122, durationS: 6498 });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).not.toContain(KEY);
    expect((init!.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe(KEY);
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      origin: { placeId: "ChIJ-milano-000" },
      destination: { location: { latLng: { latitude: 45.07, longitude: 7.68 } } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
    });
  });

  it("no route → not_found", async () => {
    const maps = createGoogleMapsProvider({ apiKey: KEY, fetch: mockFetch(200, {}) });
    await expectMapsError(maps.computeRoute({ placeId: "ChIJaaaaaaaaaa" }, { placeId: "ChIJbbbbbbbbbb" }), "not_found");
  });

  it.each([
    [400, "invalid_request"],
    [403, "unauthorized"],
    [429, "quota"],
    [503, "unavailable"],
  ])("HTTP %i → %s", async (status, code) => {
    const maps = createGoogleMapsProvider({ apiKey: KEY, fetch: mockFetch(status, { error: { message: `bad key ${KEY}` } }) });
    await expectMapsError(maps.computeRoute({ placeId: "ChIJaaaaaaaaaa" }, { placeId: "ChIJbbbbbbbbbb" }), code);
  });

  it("network error and timeout → unavailable", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expectMapsError(createGoogleMapsProvider({ apiKey: KEY, fetch: failing }).computeRoute({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }), "unavailable");
    const slow = vi.fn((_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    await expectMapsError(createGoogleMapsProvider({ apiKey: KEY, fetch: slow, timeoutMs: 20 }).computeRoute({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }), "unavailable");
  });

  it("missing key → unauthorized at construction", () => {
    expect(() => createGoogleMapsProvider({ apiKey: "" })).toThrow(MapsError);
  });
});

describe("autocomplete", () => {
  it("restricts to Italy and maps predictions", async () => {
    const fetch = mockFetch(200, {
      suggestions: [
        { placePrediction: { placeId: "ChIJ1", text: { text: "Via Roma 1, Milano, MI, Italia" }, structuredFormat: { mainText: { text: "Via Roma 1" }, secondaryText: { text: "Milano, MI, Italia" } } } },
        { queryPrediction: { text: { text: "via roma" } } },
      ],
    });
    const maps = createGoogleMapsProvider({ apiKey: KEY, fetch });
    await expect(maps.autocomplete("via roma 1", "tok")).resolves.toEqual([
      { placeId: "ChIJ1", text: "Via Roma 1, Milano, MI, Italia", mainText: "Via Roma 1", secondaryText: "Milano, MI, Italia" },
    ]);
    const body = JSON.parse(String(fetch.mock.calls[0][1]!.body));
    expect(body).toMatchObject({ input: "via roma 1", sessionToken: "tok", includedRegionCodes: ["it"] });
  });

  it("too short input → invalid_request without calling Google", async () => {
    const fetch = mockFetch(200, {});
    await expectMapsError(createGoogleMapsProvider({ apiKey: KEY, fetch }).autocomplete("ab", "tok"), "invalid_request");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("placeDetails", () => {
  it("extracts street, city, CAP and province sigla", async () => {
    const fetch = mockFetch(200, {
      id: "ChIJ-duomo-milano",
      formattedAddress: "Piazza del Duomo, 1, 20122 Milano MI, Italia",
      location: { latitude: 45.4641, longitude: 9.1919 },
      addressComponents: [
        { longText: "1", shortText: "1", types: ["street_number"] },
        { longText: "Piazza del Duomo", shortText: "Piazza del Duomo", types: ["route"] },
        { longText: "Milano", shortText: "Milano", types: ["locality", "political"] },
        { longText: "Città Metropolitana di Milano", shortText: "MI", types: ["administrative_area_level_2", "political"] },
        { longText: "Lombardia", shortText: "Lombardia", types: ["administrative_area_level_1", "political"] },
        { longText: "Italia", shortText: "IT", types: ["country", "political"] },
        { longText: "20122", shortText: "20122", types: ["postal_code"] },
      ],
    });
    const maps = createGoogleMapsProvider({ apiKey: KEY, fetch });
    await expect(maps.placeDetails("ChIJ-duomo-milano", "tok")).resolves.toEqual({
      placeId: "ChIJ-duomo-milano",
      formattedAddress: "Piazza del Duomo, 1, 20122 Milano MI, Italia",
      location: { lat: 45.4641, lng: 9.1919 },
      street: "Piazza del Duomo, 1",
      city: "Milano",
      postalCode: "20122",
      provinceCode: "MI",
      countryCode: "IT",
    });
    expect(String(fetch.mock.calls[0][0])).toContain("sessionToken=tok");
  });

  it("invalid place id → invalid_request; no location → not_found", async () => {
    await expectMapsError(createGoogleMapsProvider({ apiKey: KEY, fetch: mockFetch(200, {}) }).placeDetails("../x"), "invalid_request");
    await expectMapsError(createGoogleMapsProvider({ apiKey: KEY, fetch: mockFetch(200, { id: "ChIJaaaaaaaaaa" }) }).placeDetails("ChIJaaaaaaaaaa"), "not_found");
  });
});
