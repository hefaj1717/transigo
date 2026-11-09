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
