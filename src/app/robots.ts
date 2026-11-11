import type { MetadataRoute } from "next";
import { isIndexable, robotsRules } from "@/lib/public/seo";
import { appUrlOrNull } from "@/lib/supabase/env";

// robots.txt (D126): everything disallowed unless SITE_INDEXING=on (production only).
export default function robots(): MetadataRoute.Robots {
  const base = appUrlOrNull();
  return robotsRules(isIndexable(), base);
}
