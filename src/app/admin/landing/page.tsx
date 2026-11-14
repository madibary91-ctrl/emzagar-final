import type { Metadata } from "next";
import LandingEditor from "@/components/landing/editor/LandingEditor";
import { getBranding } from "@/modules/branding/service";
import { getDraftLanding, listLandingVersions } from "@/modules/landing/service";
import { requirePlatformAdmin } from "@/modules/platform/admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ویرایشگر صفحه‌ی اصلی", robots: { index: false, follow: false } };

export default async function LandingEditorPage() {
  await requirePlatformAdmin();
  const brand = await getBranding();
  const [{ doc, unpublished }, versions] = await Promise.all([getDraftLanding(brand.name), listLandingVersions()]);
  return (
    <LandingEditor
      initialDoc={doc}
      unpublished={unpublished}
      versions={versions.map((v) => ({ id: v.id, note: v.note, at: v.createdAt.toISOString() }))}
      brandName={brand.name}
    />
  );
}
