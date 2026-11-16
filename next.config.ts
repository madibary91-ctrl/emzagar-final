import type { NextConfig } from "next";

const baseHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // C-01: کلید عمومی فروشنده هنگام build داخل باندل سرور «تعبیه» می‌شود (ریشه‌ی اعتماد؛ با env زمان اجرا قابل تغییر نیست)
  env: { EMZ_EMBEDDED_LICENSE_PUBLIC_KEY: process.env.EMZ_EMBEDDED_LICENSE_PUBLIC_KEY ?? process.env.LICENSE_PUBLIC_KEY ?? "" },
  compress: true,
  // بسته‌ی کوچک‌تر: فقط آیکون‌ها/انیمیشن‌های استفاده‌شده وارد باندل می‌شود
  experimental: { optimizePackageImports: ["lucide-react", "motion"] },
  images: { formats: ["image/avif", "image/webp"] },
  // PDFKit فایل‌های داخلی خودش (قلم‌ها/AFM) را از دیسک می‌خواند؛ نباید باندل شود
  serverExternalPackages: ["pdfkit", "fontkit"],
  // PDF-01: قلم‌های TTF با مسیر پویا (fs) خوانده می‌شوند و ردیاب وابستگی Next آن‌ها را نمی‌بیند؛ بدون این، خروجی standalone بی‌قلم می‌شد
  outputFileTracingIncludes: { "/**": ["./assets/fonts/**/*"] },
  // بسته‌ی release (نصب بدون npm روی هاست): EMZ_STANDALONE=1 node scripts/build-release.mjs
  ...(process.env.EMZ_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // INF-07: ساخت داخل Docker فقط src را تایپ‌چک می‌کند (tsconfig.build.json)؛ پوشه‌های e2e/qa/tests/simulator/docs در .dockerignore‌اند
  // و نباید ساخت ایمیج را به‌خاطر ایمپورت‌های آن‌ها بشکنند. بقیه‌ی ساخت‌ها (CI/توسعه) همان tsconfig.json کامل را می‌گیرند.
  ...(process.env.EMZ_TSCONFIG ? { typescript: { tsconfigPath: process.env.EMZ_TSCONFIG } } : {}),
  async headers() {
    return [
      // همه‌ی صفحه‌ها: جلوگیری از Clickjacking (به‌جز /embed و پیش‌نمایش ویرایشگر که فقط هم‌مبدأ قابل‌قاب‌گرفتن است)
      { source: "/((?!embed|landing-preview).*)", headers: [...baseHeaders, { key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self';" }] },
      { source: "/landing-preview", headers: [...baseHeaders, { key: "X-Frame-Options", value: "SAMEORIGIN" }, { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self';" }] },
      { source: "/embed/:path*", headers: baseHeaders },
      // صفحه‌ی امضای بدون ثبت‌نام: توکن داخل آدرس است؛ هرگز کش یا ارجاع (Referer) نشود
      { source: "/sign/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      // لینک پیگیری ارسال سریع و رسید امضا: توکن داخل آدرس است؛ کش و Referer ممنوع
      { source: "/q/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      // کیف اسناد امضاکننده: داده‌ی شخصی پشت نشست OTP؛ هرگز کش یا ایندکس نشود
      { source: "/vault/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      // لینک پرداخت قرارداد: کد داخل آدرس است؛ کش و Referer ممنوع
      { source: "/pay/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      { source: "/receipt/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }] },
      { source: "/pdfjs/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=604800, immutable" }] },
      { source: "/verify-email/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }] },
      // دارایی‌های ثابت: کش مرورگر/CDN (آیکون‌ها و تصویر لندینگ آپلودشده با نام یکتا)
      { source: "/icons/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
      // سرویس‌ورکر هرگز نباید کش شود تا به‌روزرسانی‌ها فوراً اعمال شوند
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Content-Type", value: "application/javascript; charset=utf-8" }] },
    ];
  },
};

export default nextConfig;
