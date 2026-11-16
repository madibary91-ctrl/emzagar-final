import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { verifyPayment } from "@/modules/payments/service";
import { flashBack, paymentReturn } from "@/modules/payments/return";

export const dynamic = "force-dynamic";

/**
 * مسیر قدیمی بازگشت (زرین‌پال؛ پارامترهای Authority و Status) — برای تراکنش‌های در جریان و سازگاری حفظ شده است.
 * مسیر جدید و چنددرگاهی: /api/billing/callback/[gateway]
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const ip = clientIpFrom((n) => req.headers.get(n));
  const back = (path: string, q: string) => new Response(null, { status: 303, headers: { Location: `${path}?${q}`, "Cache-Control": "no-store" } });
  if (!rateLimit(`billing:cb:${ip}`, 30, 60_000).ok) { const f = flashBack("/admin/billing", "error", "درخواست‌های زیاد بود؛ کمی بعد صفحه را دوباره باز کنید (پرداخت شما در صورت انجام، در «تاریخچه‌ی پرداخت‌ها» ثبت می‌شود)."); return back(f.dest, f.query); }
  const authority = u.searchParams.get("Authority") || "";
  const r = await verifyPayment(authority, u.searchParams.get("Status") || "");
  const { dest, query } = await paymentReturn(r, authority);
  return back(dest, query);
}
