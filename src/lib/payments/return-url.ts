// Stripe Checkout must send the customer back to the same origin they paid from: the session cookie belongs to
// that host. The demo is reachable on several Vercel domains (e.g. the production alias and a staging alias); a
// fixed APP_URL sent customers who paid on another alias to a host without their session → login screen.
//
// The origin comes from the request that started the payment (Server Action: Next already rejects actions whose
// Origin does not match the Host), and is accepted only for known hosts; anything else falls back to the
// configured app URL.

export type RequestHost = { host: string | null; proto: string | null };

const HOSTNAME = /^[a-z0-9.-]+(:\d{1,5})?$/;
const LOCAL = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d{1,5})?$/;

/** Base URL (no trailing slash) for Checkout return URLs: the request's origin when it is trusted, else `fallback`. */
export function checkoutReturnBase(req: RequestHost, fallback: string): string {
  const host = req.host?.split(",")[0].trim().toLowerCase() ?? "";
  if (!host || !HOSTNAME.test(host)) return fallback;

  if (LOCAL.test(host)) {
    // Local dev (also phones over Wi-Fi): http unless the proxy says https.
    const proto = req.proto?.split(",")[0].trim().toLowerCase() === "https" ? "https" : "http";
    return `${proto}://${host}`;
  }

  let fallbackHost: string | null = null;
  try {
    fallbackHost = new URL(fallback).host.toLowerCase();
  } catch {
    fallbackHost = null;
  }
  // Public hosts: always https. Our Vercel aliases, or the configured app domain (a custom domain later).
  if (host === fallbackHost || (!host.includes(":") && host.endsWith(".vercel.app"))) return `https://${host}`;
  return fallback;
}
