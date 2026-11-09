// Structured data (JSON-LD) for the public pages. JSON.stringify does not escape "<", so a text containing
// "</script>" could end the script tag: every "<" is written as < (Next.js JSON-LD guide).
import type { Faq } from "./content";

export function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/** schema.org FAQPage for the FAQ page. */
export function faqPageJsonLd(faqs: Faq[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

// ---------------------------------------------------------------------------
// Indexing (D126): only the production site is indexed. Everything else (local, staging, Vercel previews)
// is "noindex" unless SITE_INDEXING=on is set explicitly — a forgotten variable hides the site, it never
// exposes a test environment to search engines.
// ---------------------------------------------------------------------------

export function isIndexable(env: Record<string, string | undefined> = process.env): boolean {
  return env.SITE_INDEXING === "on";
}

/** Public pages listed in the sitemap (account, booking and panel pages are left out). */
export const SITEMAP_PATHS = [
  "/",
  "/servizi",
  "/servizi/trasporto",
  "/servizi/facchinaggio",
  "/servizi/imballaggio",
  "/servizi/deposito-merci",
  "/come-funziona",
  "/domande-frequenti",
  "/diventa-partner",
  "/contatti",
  "/termini",
  "/privacy",
  "/cookie",
] as const;

/** Areas never meant for search engines, even on production. */
export const ROBOTS_DISALLOW = ["/admin", "/cliente", "/padroncino", "/api/", "/auth/", "/prenota", "/completa-profilo", "/reimposta-password", "/account-sospeso"];

export function robotsRules(indexable: boolean, baseUrl: string | null) {
  if (!indexable) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ROBOTS_DISALLOW }],
    ...(baseUrl ? { sitemap: `${baseUrl}/sitemap.xml` } : {}),
  };
}
