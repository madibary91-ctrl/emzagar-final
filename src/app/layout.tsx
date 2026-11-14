import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "@fontsource/vazirmatn/400.css";
import "@fontsource/vazirmatn/500.css";
import "@fontsource/vazirmatn/600.css";
import "@fontsource/vazirmatn/700.css";
import "@fontsource/vazirmatn/800.css";
import "@fontsource/vazirmatn/900.css";
import "./globals.css";
import { MotionProvider } from "@/components/MotionProvider";
import PwaRegister from "@/components/PwaRegister";
import FeedbackManager from "@/components/FeedbackManager";
import { getBranding, resolveTheme } from "@/modules/branding/service";
import { siteOrigin } from "@/lib/seo";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const [b, origin] = await Promise.all([getBranding(), siteOrigin()]);
  const description = "صدور، امضا و مدیریت قراردادهای دیجیتال با احراز هویت پیامکی، شناسنامه‌ی دیجیتال و استعلام اصالت سند";
  let metadataBase: URL | undefined;
  try {
    metadataBase = new URL(origin);
  } catch {
    metadataBase = undefined;
  }
  return {
    metadataBase,
    title: { default: `${b.name} — امضای آنلاین قرارداد`, template: `%s | ${b.name}` },
    description,
    applicationName: b.name,
    formatDetection: { telephone: false, email: false, address: false },
    openGraph: { type: "website", locale: "fa_IR", siteName: b.name, title: `${b.name} — امضای آنلاین قرارداد`, description },
    twitter: { card: "summary_large_image", title: `${b.name} — امضای آنلاین قرارداد`, description },
    manifest: "/manifest.webmanifest",
    icons: { icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }], apple: "/icons/apple-touch-icon.png" },
    appleWebApp: { capable: true, title: "امضاگیر", statusBarStyle: "default" },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f3ed" },
    { media: "(prefers-color-scheme: dark)", color: "#0a1618" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// اگر تم «سیستم» باشد، پیش از رندر از ترجیح دستگاه خوانده می‌شود (بدون پرش رنگ)
const SYSTEM_THEME_SCRIPT = `try{var d=document.documentElement;if(d.dataset.theme==="system"){d.dataset.theme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}}catch(e){}`;

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const brand = await getBranding();
  const theme = await resolveTheme(brand.defaultTheme);
  const nonce = (await headers()).get("x-nonce") ?? undefined; // M-07: nonce همین درخواست (proxy.ts)
  return (
    <html lang="fa" dir="rtl" data-theme={theme} suppressHydrationWarning>
      <head>
        {/* فقط رنگ‌های hex اعتبارسنجی‌شده در CSS درج می‌شوند */}
        <style dangerouslySetInnerHTML={{ __html: brand.css }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} />
      </head>
      <body>
        <MotionProvider>{children}</MotionProvider>
        <PwaRegister />
        <FeedbackManager />
      </body>
    </html>
  );
}
