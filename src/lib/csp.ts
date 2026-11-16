/**
 * M-07 — Content-Security-Policy واقعی با «nonce» برای هر درخواست.
 *
 * پیش‌تر CSP فقط `frame-ancestors` و `base-uri` داشت؛ یعنی ۱۵ نقطه‌ی `dangerouslySetInnerHTML` هیچ لایه‌ی دفاعی دومی
 * نداشتند. اکنون:
 *  • `script-src 'self' 'nonce-…' 'strict-dynamic'`: فقط اسکریپت‌هایی اجرا می‌شوند که سرور برایشان nonce یکتا ساخته است؛
 *    هر `<script>` تزریق‌شده (XSS ذخیره‌شده/بازتابی) و هر handler درون‌خطی (onclick=…) مسدود می‌شود.
 *  • `object-src 'none'`، `base-uri 'self'`، `form-action 'self'`، `frame-ancestors` به‌ازای مسیر، `connect-src 'self'`.
 *  • `style-src` عمداً 'unsafe-inline' دارد (Tailwind/Next و style="" گسترده)؛ تزریق CSS بسیار کم‌خطرتر از اجرای اسکریپت است.
 * nonce را `proxy.ts` برای هر درخواست می‌سازد و Next.js خودکار روی اسکریپت‌های خودش می‌گذارد (همه‌ی صفحه‌ها dynamic هستند).
 */
export type FrameMode = "none" | "self" | "any";

export function frameModeFor(pathname: string): FrameMode {
  if (pathname === "/embed" || pathname.startsWith("/embed/")) return "any"; // ویجت قابل‌جاسازی در سایت مشتری (رفتار قبلی)
  if (pathname === "/landing-preview" || pathname.startsWith("/landing-preview/")) return "self";
  return "none";
}

export function newNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export function buildCsp(nonce: string, opts: { frame?: FrameMode; dev?: boolean } = {}): string {
  const dev = opts.dev ?? process.env.NODE_ENV !== "production";
  const frame = opts.frame ?? "none";
  const ancestors = frame === "any" ? "*" : frame === "self" ? "'self'" : "'none'";
  const d: string[] = [
    "default-src 'self'",
    // 'wasm-unsafe-eval': pdf.js (JPEG2000/JBIG2). 'unsafe-eval' فقط در توسعه (React Refresh)
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' blob: data:${dev ? " ws: wss:" : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${ancestors}`,
  ];
  if (!dev) d.push("upgrade-insecure-requests");
  return d.join("; ");
}
