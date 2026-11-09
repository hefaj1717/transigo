import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  async headers() {
    return [
      {
        // Carrier PWA service worker (D104): always revalidated, scope /padroncino (the file lives in /padroncino/,
        // whose default scope "/padroncino/" would not include the start URL "/padroncino").
        source: "/padroncino/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/padroncino" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
      {
        source: "/padroncino/manifest.webmanifest",
        headers: [{ key: "Content-Type", value: "application/manifest+json" }],
      },
    ];
  },
  partialPrefetching: true,
  turbopack: {
    // Pin the workspace root: a stray package-lock.json in a parent folder
    // otherwise makes Next.js guess the wrong root.
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
