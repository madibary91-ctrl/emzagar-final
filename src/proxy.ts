import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, frameModeFor, isRscPrefetch, newNonce } from "@/lib/csp";
import { isInstalled } from "@/modules/install/service";

/**
 * ۱) تا پیش از پایان نصب، همه‌ی صفحه‌ها به نصب‌کننده‌ی وب هدایت می‌شوند
 *    (و APIها پاسخ 503 می‌گیرند). پس از نصب این بررسی از حافظه جواب می‌دهد و هزینه‌ای ندارد.
 * ۲) M-07: برای هر «صفحه» یک nonce یکتا ساخته و CSP کامل (lib/csp.ts) روی درخواست و پاسخ گذاشته می‌شود.
 *    Next.js nonce را از هدر Content-Security-Policy «درخواست» می‌خواند و روی اسکریپت‌های خودش می‌زند؛
 *    `x-nonce` برای اسکریپت‌های درون‌خطی خود ما (layout) است.
 *
 * S00-F01 (Critical): پیش‌تر `matcher` درخواست‌های دارای هدر `Next-Router-Prefetch` یا `Purpose: prefetch` را «کلاً» از
 * پراکسی بیرون می‌گذاشت. هدر را هر کلاینتی می‌تواند بفرستد؛ پس در فاصله‌ی «ساخت جدول‌ها ← ساخت مدیر» مهاجم با همین هدر
 * دروازه‌ی نصب را دور می‌زد، /register را صدا می‌زد و چون ثبت‌نامِ «اولین مدیر» مدیر کل می‌شود (modules/auth/actions.ts)،
 * مدیر کل پلتفرم می‌شد و نصب‌کننده برای مالک واقعی بسته می‌ماند. اکنون پراکسی همیشه اجرا می‌شود؛ دروازه‌ی نصب بی‌قید و شرط است
 * و فقط «ساخت nonce» برای پیش‌خوان‌های واقعی RSC (هدر RSC هم دارند) کنار گذاشته می‌شود.
 */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const gateExempt = pathname === "/install" || pathname.startsWith("/install/") || pathname === "/api/health" || pathname.startsWith("/api/health/");

  if (!gateExempt && !(await isInstalled())) {
    if (isApi) return NextResponse.json({ error: "not_installed", message: "سامانه هنوز نصب نشده است" }, { status: 503 });
    const url = req.nextUrl.clone();
    url.pathname = "/install";
    url.search = "";
    return NextResponse.redirect(url);
  }
  if (isApi) return NextResponse.next(); // پاسخ‌های JSON/فایل: CSP صفحه لازم نیست (هدرهای next.config.ts اعمال می‌شود)
  // پیش‌خوان‌های prefetch لینک نیازی به CSP ندارند و nonce را بی‌دلیل می‌سوزانند (فقط پس از دروازه‌ی نصب)
  if (req.method === "GET" && isRscPrefetch((n) => req.headers.get(n))) return NextResponse.next();

  const nonce = newNonce();
  const csp = buildCsp(nonce, { frame: frameModeFor(pathname) });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  // S00-F01: هیچ شرط `missing` (وابسته به هدر کلاینت) در matcher نیست؛ فقط دارایی‌های ثابت کنار گذاشته می‌شوند
  matcher: ["/((?!_next/static|_next/image|icons/|sw\\.js|manifest\\.webmanifest|offline\\.html|favicon\\.ico|pdfjs/).*)"],
};
