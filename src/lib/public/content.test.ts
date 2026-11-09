import { describe, expect, it } from "vitest";
import { CARRIER_DOCUMENT_TYPES } from "@/lib/carriers/document-types";
import { FAQ_GROUPS, FAQS, HOME_FAQS } from "./content";
import { partnerDocuments } from "./partner";
import { faqPageJsonLd, jsonLdString } from "./seo";

describe("FAQ", () => {
  it("every question belongs to a listed group, questions are unique", () => {
    const groups = new Set(FAQ_GROUPS.map((g) => g.code));
    expect(FAQS.every((f) => groups.has(f.group))).toBe(true);
    expect(new Set(FAQS.map((f) => f.q)).size).toBe(FAQS.length);
    expect(HOME_FAQS.length).toBeGreaterThan(0);
  });

  it("never mentions long-term storage (D117)", () => {
    expect(FAQS.map((f) => f.q + f.a).join(" ").toLowerCase()).not.toMatch(/lungo termine/);
  });
});

describe("JSON-LD", () => {
  it("builds a FAQPage with every question", () => {
    const ld = faqPageJsonLd(FAQS);
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity).toHaveLength(FAQS.length);
    expect(ld.mainEntity[0]).toMatchObject({ "@type": "Question", acceptedAnswer: { "@type": "Answer" } });
  });

  it("escapes < so a text cannot close the script tag", () => {
    const out = jsonLdString({ a: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("<");
    expect(JSON.parse(out)).toEqual({ a: "</script><script>alert(1)</script>" });
  });
});

describe("partnerDocuments", () => {
  it("lists only documents the app accepts, in onboarding order", () => {
    const docs = partnerDocuments();
    const accepted = CARRIER_DOCUMENT_TYPES.filter((t) => t.isAccepted);
    expect(docs).toHaveLength(accepted.length);
    expect(docs.map((d) => d.label)).not.toContain("Documento d'identità"); // verified by Stripe (D97)
    expect(docs.find((d) => d.label === "Libretto di circolazione")).toMatchObject({ perVehicle: true, required: true });
    expect(docs.find((d) => d.label === "Polizza RC vettoriale")).toMatchObject({ required: false });
  });
});
