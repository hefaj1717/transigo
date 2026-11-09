import { describe, expect, it } from "vitest";
import { renderContactRequestEmail } from "@/lib/notifications/templates/contact-request";
import { CONTACT_MSG, HONEYPOT_FIELD, parseContactForm } from "./form";
import { clientIp, hashIp } from "./ip";

const fd = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
const valid = { name: " Mario Rossi ", email: "mario@example.com", phone: "", message: "Vorrei un trasporto per un divano.", privacy: "on" };

describe("parseContactForm", () => {
  it("accepts a valid form and trims values", () => {
    expect(parseContactForm(fd(valid))).toEqual({ kind: "ok", input: { ...valid, name: "Mario Rossi" } });
  });

  it("a filled honeypot is a bot, before any validation", () => {
    expect(parseContactForm(fd({ [HONEYPOT_FIELD]: "http://spam.example" }))).toEqual({ kind: "bot" });
  });

  it("returns field errors and the values to show again", () => {
    const r = parseContactForm(fd({ ...valid, email: "x", message: "corto", privacy: "", phone: "abc" }));
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.state.message).toBe(CONTACT_MSG.invalid);
    expect(Object.keys(r.state.fieldErrors ?? {}).sort()).toEqual(["email", "message", "phone", "privacy"]);
    expect(r.state.values).toEqual({ name: valid.name, email: "x", phone: "abc", message: "corto" });
  });

  it("requires the privacy consent", () => {
    const r = parseContactForm(fd({ ...valid, privacy: "" }));
    expect(r.kind === "invalid" && r.state.fieldErrors?.privacy).toMatch(/privacy/);
  });
});

describe("IP", () => {
  const headers = (h: Record<string, string>) => (n: string) => h[n] ?? null;
  it("takes the first x-forwarded-for entry, then x-real-ip, else 'unknown'", () => {
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }))).toBe("203.0.113.5");
    expect(clientIp(headers({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(headers({}))).toBe("unknown");
  });

  it("hashes with the secret (64 hex chars, stable, secret-dependent), never returns the IP", () => {
    const s1 = "a".repeat(32);
    const h = hashIp("203.0.113.5", s1);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp("203.0.113.5", s1)).toBe(h);
    expect(hashIp("203.0.113.5", "b".repeat(32))).not.toBe(h);
    expect(h).not.toContain("203");
    expect(() => hashIp("1.2.3.4", "short")).toThrow();
  });
});

describe("contact_request e-mail", () => {
  it("contains only the kind and the link — no personal data", () => {
    const m = renderContactRequestEmail({ kind: "out_of_area", requestId: "r-1", adminUrl: "https://x.example/admin/richieste/r-1" });
    expect(m.subject).toMatch(/zona non servita/);
    expect(m.text).toContain("https://x.example/admin/richieste/r-1");
    expect(renderContactRequestEmail({ kind: "general", requestId: "r-2", adminUrl: "u" }).subject).toBe("Nuova richiesta di contatto");
  });
});
