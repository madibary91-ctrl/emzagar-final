import { NextResponse, type NextRequest } from "next/server";
import { isInstalled } from "@/modules/install/service";

/**
 * تا پیش از پایان نصب، همه‌ی صفحه‌ها به نصب‌کننده‌ی وب هدایت می‌شوند
 * (و APIها پاسخ 503 می‌گیرند). پس از نصب این بررسی از حافظه جواب می‌دهد و هزینه‌ای ندارد.
 */
export async function proxy(req: NextRequest) {
  if (await isInstalled()) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "not_installed", message: "سامانه هنوز نصب نشده است" }, { status: 503 });
  const url = req.nextUrl.clone();
  url.pathname = "/install";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!install|api/health|_next/|icons/|sw\\.js|manifest\\.webmanifest|offline\\.html|favicon\\.ico).*)"],
};
