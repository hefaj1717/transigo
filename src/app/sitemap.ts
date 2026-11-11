import type { MetadataRoute } from "next";
import { isIndexable, SITEMAP_PATHS } from "@/lib/public/seo";
import { appUrlOrNull } from "@/lib/supabase/env";

// sitemap.xml (D126): public pages only; empty when the site is not indexable (staging, previews, local).
export default function sitemap(): MetadataRoute.Sitemap {
  const base = appUrlOrNull();
  if (!isIndexable() || !base) return [];
  return SITEMAP_PATHS.map((path) => ({ url: `${base}${path === "/" ? "" : path}`, changeFrequency: "monthly", priority: path === "/" ? 1 : 0.6 }));
}
