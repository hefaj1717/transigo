import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTACT_MSG, HONEYPOT_FIELD } from "@/lib/contact/form";

// "Out of area" request from the wizard (D125, spec 2a): bots and invalid input reach neither Google nor the
// database; the route is resolved on the server from the place IDs only (D76).

const env = vi.hoisted(() => ({ serviceCreated: 0 }));
const server = vi.hoisted(() => ({ submitContactRequest: vi.fn() }));
const booking = vi.hoisted(() => ({ resolveRouteSummary: vi.fn() }));

vi.mock("next/headers", () => ({ headers: async () => ({ get: (n: string) => (n === "x-forwarded-for" ? "203.0.113.9" : null) }) }));
vi.mock("@/lib/supabase/env", () => ({ getAppUrl: () => "https://transigo.example" }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => { env.serviceCreated++; return {}; } }));
vi.mock("@/lib/contact/server", () => server);
vi.mock("@/lib/booking/server", () => booking);

const { sendOutOfAreaAction } = await import("./out-of-area-actions");

const A = "ChIJpickupPlace0001";
const B = "ChIJdeliveryPlace002";
const ROUTE = { pickupCity: "Roma", pickupProvince: "RM", deliveryCity: "Napoli", deliveryProvince: "NA", distanceKm: 225 };
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
const valid = { name: "Mario Rossi", email: "mario@example.com", phone: "", message: "Trasloco bilocale a dicembre.", privacy: "on", pickupPlaceId: A, deliveryPlaceId: B };

beforeEach(() => {
  env.serviceCreated = 0;
  server.submitContactRequest.mockReset().mockResolvedValue({ status: "created", id: "r1" });
  booking.resolveRouteSummary.mockReset().mockResolvedValue(ROUTE);
  vi.stubEnv("CONTACT_IP_HASH_SECRET", "s".repeat(40));
});

describe("sendOutOfAreaAction", () => {
  it("bot or invalid input: neither Google nor the database is used", async () => {
    expect(await sendOutOfAreaAction({ status: "idle" }, form({ ...valid, [HONEYPOT_FIELD]: "x" }))).toMatchObject({ status: "sent" });
    expect((await sendOutOfAreaAction({ status: "idle" }, form({ ...valid, privacy: "" }))).status).toBe("error");
    expect(booking.resolveRouteSummary).not.toHaveBeenCalled();
    expect(server.submitContactRequest).not.toHaveBeenCalled();
    expect(env.serviceCreated).toBe(0);
  });

  it("valid: route resolved on the server from the place IDs and saved as out_of_area", async () => {
    expect(await sendOutOfAreaAction({ status: "idle" }, form(valid))).toEqual({ status: "sent", message: CONTACT_MSG.sent });
    expect(booking.resolveRouteSummary).toHaveBeenCalledWith(A, B);
    expect(server.submitContactRequest.mock.calls[0][2]).toEqual(ROUTE);
  });

  it("invalid place IDs: saved without route fields, Google not called", async () => {
    await sendOutOfAreaAction({ status: "idle" }, form({ ...valid, pickupPlaceId: "bad id!" }));
    expect(booking.resolveRouteSummary).not.toHaveBeenCalled();
    expect(server.submitContactRequest.mock.calls[0][2]).toEqual({ pickupCity: null, pickupProvince: null, deliveryCity: null, deliveryProvince: null, distanceKm: null });
  });
});
