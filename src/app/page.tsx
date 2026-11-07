import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LandingRenderer } from "@/components/landing/LandingRenderer";
import { getCurrentUser } from "@/modules/auth/session";
import { getBranding } from "@/modules/branding/service";
import { isInstalled } from "@/modules/install/service";
import { getPublishedLanding } from "@/modules/landing/service";
import { ensureSeed } from "@/modules/seed";
import { homeFor } from "@/modules/tenancy/context";
import { jsonLdString, siteOrigin } from "@/lib/seo";
import { PLANS, PLAN_ORDER } from "@/modules/billing/plans";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBranding();
  const doc = await getPublishedLanding(brand.name);
  const title = String(doc.seo.title || `${brand.name} — امضای آنلاین قرارداد`);
  const description = String(doc.seo.description || "");
  const image = String(doc.seo.image || "");
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: "/" },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } },
    openGraph: { url: "/", title, description, type: "website", locale: "fa_IR", siteName: brand.name, ...(image ? { images: [{ url: image }] } : {}) },
    twitter: { card: image ? "summary_large_image" : "summary", title, description, ...(image ? { images: [image] } : {}) },
  };
}

export default async function Home() {
  if (!(await isInstalled())) redirect("/install");
  await ensureSeed();
  const [user, brand] = await Promise.all([getCurrentUser(), getBranding()]);
  const doc = await getPublishedLanding(brand.name);
  const panelHref = user ? await homeFor(user.id) : "/login";
  const origin = await siteOrigin();
  const name = String(doc.theme.brandName || brand.name);
  const description = String(doc.seo.description || "");
  // پرسش‌های متداول صفحه برای نتیجه‌ی غنی گوگل (FAQPage)
  const faqs = doc.sections
    .filter((s) => s.enabled && s.type === "faq")
    .flatMap((s) => (Array.isArray(s.props.items) ? s.props.items : []))
    .map((it) => ({ q: String(it.q ?? ""), a: String(it.a ?? "") }))
    .filter((f) => f.q && f.a)
    .slice(0, 10);
  const jsonLd = [
    { "@context": "https://schema.org", "@type": "Organization", name, url: origin, logo: brand.logoUrl ? new URL(brand.logoUrl, origin).toString() : `${origin}/icons/icon-192.png` },
    { "@context": "https://schema.org", "@type": "WebSite", name, url: origin, inLanguage: "fa-IR" },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description,
      inLanguage: "fa-IR",
      offers: PLAN_ORDER.map((id) => ({ "@type": "Offer", name: PLANS[id].name, price: String(PLANS[id].priceToman), priceCurrency: "IRT" })),
    },
    ...(faqs.length ? [{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) }] : []),
  ];
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(jsonLd) }} />
      <LandingRenderer doc={doc} ctx={{ loggedIn: !!user, panelHref, brandName: brand.name }} />
    </>
  );
}
