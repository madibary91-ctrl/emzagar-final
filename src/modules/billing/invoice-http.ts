import { NextResponse } from "next/server";
import { wantsPage } from "@/modules/vault/http";

/** پیام‌های صفحه‌ی فاکتورها (کد در `?e=`) */
export const INVOICE_ERRORS: Record<string, string> = {
  auth: "نشست شما تمام شده است؛ دوباره وارد شوید تا فاکتور دانلود شود.",
  rate: "درخواست‌های دانلود زیاد بود؛ یک دقیقه بعد دوباره تلاش کنید.",
  nodoc: "این فاکتور پیدا نشد یا به فضای کاری شما تعلق ندارد.",
  pdf: "ساخت فایل PDF این فاکتور الان ممکن نشد؛ چند لحظه بعد دوباره تلاش کنید.",
};

const JSON_ERR: Record<string, string> = { auth: "unauthorized", rate: "too_many_requests", nodoc: "not_found", pdf: "pdf_failed" };

/**
 * خطای مسیرهای دانلود فاکتور. مرورگر (کلیک روی لینک) → صفحه‌ی فاکتورها با پیام (یا صفحه‌ی ورود با بازگشت به همان‌جا)؛
 * کلاینت برنامه‌ای (fetch/API/آزمون) → همان کد وضعیت و متن مختصر قبلی.
 */
export function invoiceFail(req: Request, code: keyof typeof INVOICE_ERRORS, status: number): Response {
  if (wantsPage(req)) {
    const to = code === "auth" ? `/login?next=${encodeURIComponent("/admin/billing/invoices")}` : `/admin/billing/invoices?e=${encodeURIComponent(code)}`;
    return NextResponse.redirect(new URL(to, req.url), { status: 303, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  }
  const text = status === 401 ? "Unauthorized" : status === 404 ? "Not found" : status === 429 ? "Too many requests" : JSON_ERR[code];
  return new Response(text, { status, headers: { "Cache-Control": "no-store" } });
}
