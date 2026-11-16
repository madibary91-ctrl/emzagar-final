import type { MetadataRoute } from "next";
import { PRIVATE_PATHS, siteOrigin } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await siteOrigin();
  return {
    rules: [{ userAgent: "*", allow: ["/", "/pricing", "/register", "/verify"], disallow: PRIVATE_PATHS }],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
