import type { MetadataRoute } from "next";
import { allDocs } from "@/lib/docs";
import { site } from "@/lib/site";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${site.url}/` }, ...allDocs.map((page) => ({ url: `${site.url}${page.href}` }))];
}
