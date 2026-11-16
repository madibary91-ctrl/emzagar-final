import { NextResponse } from "next/server";

/**
 * خطای مسیرهای دانلود کیف اسناد.
 * کاربر با «کلیک روی لینک» وارد این مسیرها می‌شود؛ نشان‌دادن JSON خام (`{"error":"unauthorized"}`) بن‌بست است.
 * اگر درخواست از مرورگر و برای نمایش صفحه باشد (Accept: text/html یا Sec-Fetch-Mode: navigate) به کیف با پیام روشن
 * برمی‌گردیم؛ کلاینت‌های برنامه‌ای (fetch/API/آزمون) همان JSON و کد وضعیت قبلی را می‌گیرند.
 */
export function wantsPage(req: Request): boolean {
  const mode = req.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (req.headers.get("accept") || "").includes("text/html");
}

export function vaultFail(req: Request, code: string, status: number, jsonError: string): NextResponse {
  if (wantsPage(req)) {
    const to = code === "auth" ? "/vault?e=auth" : `/vault?e=${encodeURIComponent(code)}`;
    return NextResponse.redirect(new URL(to, req.url), { status: 303, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  }
  return NextResponse.json({ error: jsonError }, { status, headers: { "Cache-Control": "private, no-store" } });
}
