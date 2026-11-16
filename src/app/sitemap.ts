import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/seo";

export const dynamic = "force-dynamic";

/** نقشه‌ی سایت: فقط صفحه‌های عمومیِ قابل‌ایندکس */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  const now = new Date();
  return [
    { url: `${origin}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${origin}/pricing`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${origin}/register`, lastModified: now, changeFrequency: "yearly", priority: 0.6 },
    { url: `${origin}/verify`, lastModified: now, changeFrequency: "yearly", priority: 0.4 },
  ];
}
