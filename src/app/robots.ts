import type { MetadataRoute } from "next";
import { isIndexable, robotsRules } from "@/lib/public/seo";

// robots.txt (D126): everything disallowed unless SITE_INDEXING=on (production only).
export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") || null;
  return robotsRules(isIndexable(), base);
}
