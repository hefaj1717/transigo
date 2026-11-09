import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTACT_MSG, HONEYPOT_FIELD } from "@/lib/contact/form";
import { hashIp } from "@/lib/contact/ip";

// Public contact action (D125): bots and invalid input never reach the service role or the database; the IP
// is passed only as an HMAC; rate limit and errors keep the typed values.

const env = vi.hoisted(() => ({ headers: {} as Record<string, string>, serviceCreated: 0 }));
const server = vi.hoisted(() => ({ submitContactRequest: vi.fn() }));

vi.mock("next/headers", () => ({ headers: async () => ({ get: (n: string) => env.headers[n] ?? null }) }));
vi.mock("@/lib/supabase/env", () => ({ getAppUrl: () => "https://transigo.example" }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => { env.serviceCreated++; return { service: true }; } }));
vi.mock("@/lib/contact/server", () => server);

const { sendContactAction } = await import("./actions");

const SECRET = "s".repeat(40);
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
const valid = { name: "Mario Rossi", email: "mario@example.com", phone: "", message: "Vorrei un trasporto per un divano.", privacy: "on" };

beforeEach(() => {
  env.headers = { "x-forwarded-for": "203.0.113.5, 10.0.0.1" };
  env.serviceCreated = 0;
  server.submitContactRequest.mockReset();
  vi.stubEnv("CONTACT_IP_HASH_SECRET", SECRET);
  vi.stubEnv("ADMIN_NOTIFICATION_EMAIL", "team@example.com");
});

describe("sendContactAction", () => {
  it("bot (honeypot): pretends success, nothing reaches the server", async () => {
    const r = await sendContactAction({ status: "idle" }, form({ ...valid, [HONEYPOT_FIELD]: "x" }));
    expect(r).toEqual({ status: "sent", message: CONTACT_MSG.sent });
    expect(server.submitContactRequest).not.toHaveBeenCalled();
    expect(env.serviceCreated).toBe(0);
  });

  it("invalid input: field errors, nothing reaches the server", async () => {
    const r = await sendContactAction({ status: "idle" }, form({ ...valid, privacy: "" }));
    expect(r.status).toBe("error");
    expect(r.fieldErrors?.privacy).toBeTruthy();
    expect(server.submitContactRequest).not.toHaveBeenCalled();
    expect(env.serviceCreated).toBe(0);
  });

  it("missing secret: generic error, nothing reaches the server", async () => {
    vi.stubEnv("CONTACT_IP_HASH_SECRET", "");
    const r = await sendContactAction({ status: "idle" }, form(valid));
    expect(r).toMatchObject({ status: "error", message: CONTACT_MSG.generic });
    expect(env.serviceCreated).toBe(0);
  });

  it("valid: saved with the HMAC of the client IP (never the IP)", async () => {
    server.submitContactRequest.mockResolvedValue({ status: "created", id: "r1" });
    const r = await sendContactAction({ status: "idle" }, form(valid));
    expect(r).toEqual({ status: "sent", message: CONTACT_MSG.sent });
    const [deps, input] = server.submitContactRequest.mock.calls[0];
    expect(deps).toMatchObject({ ipHash: hashIp("203.0.113.5", SECRET), appUrl: "https://transigo.example", adminEmail: "team@example.com" });
    expect(JSON.stringify(deps)).not.toContain("203.0.113.5");
    expect(input).toMatchObject({ name: "Mario Rossi", privacy: "on" });
  });

  it("rate limited: message and the typed values back", async () => {
    server.submitContactRequest.mockResolvedValue({ status: "rate_limited" });
    const r = await sendContactAction({ status: "idle" }, form(valid));
    expect(r).toMatchObject({ status: "error", message: CONTACT_MSG.rateLimited, values: { name: "Mario Rossi", message: valid.message } });
  });

  it("database error: generic message, values kept", async () => {
    server.submitContactRequest.mockRejectedValue(new Error("boom"));
    const r = await sendContactAction({ status: "idle" }, form(valid));
    expect(r).toMatchObject({ status: "error", message: CONTACT_MSG.generic, values: { email: "mario@example.com" } });
  });
});
