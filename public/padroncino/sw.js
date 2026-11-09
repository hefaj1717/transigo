// Service worker of the carrier PWA (D104). Scope: /padroncino.
// Privacy rule: never cache anything that depends on the session — pages, Server Action / RSC responses,
// API routes, Supabase (another origin). Cached: only content-hashed static assets, the icons and the
// offline page. Navigations go to the network; when it fails, the offline page is shown.
// Bump VERSION whenever this file or the precached files change.

const VERSION = "v1";
const CACHE = `transigo-padroncino-${VERSION}`;
const OFFLINE_URL = "/padroncino/offline.html";
const PRECACHE = [
  OFFLINE_URL,
  "/padroncino/icons/icon-192.png",
  "/padroncino/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })))),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("transigo-padroncino-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  // /_next/static/* files have content hashes in their names, so they never change under the same URL.
  return url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/padroncino/icons/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase, Google Maps, Stripe: never touched

  if (request.mode === "navigate") {
    // Network only (the response is NOT stored); offline → the static offline page.
    event.respondWith(
      fetch(request).catch(() => caches.open(CACHE).then((cache) => cache.match(OFFLINE_URL))),
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === "basic") cache.put(request, response.clone());
        return response;
      }),
    );
  }
  // Everything else (RSC payloads, Server Actions, /api/*): default network handling, no cache.
});
