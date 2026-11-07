import type { Metadata } from "next";
import PreviewClient from "@/components/landing/PreviewClient";
import { getBranding } from "@/modules/branding/service";
import { getDraftLanding } from "@/modules/landing/service";
import { requirePlatformAdmin } from "@/modules/platform/admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "پیش‌نمایش صفحه‌ی اصلی", robots: { index: false, follow: false } };

/** فقط برای ویرایشگر (داخل iframe هم‌مبدأ)؛ پیش‌نویس را نشان می‌دهد نه نسخه‌ی منتشرشده را */
export default async function LandingPreviewPage() {
  await requirePlatformAdmin();
  const brand = await getBranding();
  const { doc } = await getDraftLanding(brand.name);
  return <PreviewClient initial={doc} ctx={{ loggedIn: false, panelHref: "/admin", brandName: brand.name }} />;
}
