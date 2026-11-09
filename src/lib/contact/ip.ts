// Sender IP for the contact rate limit (D125). Only an HMAC of the IP is stored, never the IP.
import { createHmac } from "node:crypto";

/**
 * Client IP from the request headers. On Vercel x-forwarded-for is set by the platform (first entry = client).
 * Without any header (e.g. local tools) all requests share the "unknown" bucket — stricter, never looser.
 */
export function clientIp(get: (name: string) => string | null): string {
  const forwarded = get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const real = get("x-real-ip")?.trim();
  return real || "unknown";
}

/** HMAC-SHA256 (hex) of the IP with the server secret CONTACT_IP_HASH_SECRET. */
export function hashIp(ip: string, secret: string): string {
  if (secret.length < 32) throw new Error("CONTACT_IP_HASH_SECRET must be at least 32 characters");
  return createHmac("sha256", secret).update(ip.toLowerCase()).digest("hex");
}
