import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { getAdapter } from "@/modules/payments/registry";
import { verifyPayment } from "@/modules/payments/service";
import { flashBack, paymentReturn } from "@/modules/payments/return";
import { authorityKey } from "@/modules/payments/types";

export const dynamic = "force-dynamic";

/**
 * بازگشت از هر درگاه پرداخت (GET یا POST — مثلاً آیدی‌پی و Pay.ir با POST برمی‌گردند).
 * هر آداپتور پارامترهای درگاه خودش را به «توکن + موفق/ناموفق» تبدیل می‌کند؛ تایید نهایی همیشه سمت سرور
 * و با درگاهِ ثبت‌شده در خود تراکنش انجام می‌شود (نه با آنچه در آدرس آمده).
 */
async function handle(req: Request, gateway: string) {
  const ip = clientIpFrom((n) => req.headers.get(n));
  // آدرس نسبی: به میزبان داخلی سرور وابسته نیست و هدر Host هم جعل‌پذیر نیست
  const back = (path: string, q: string) => new Response(null, { status: 303, headers: { Location: `${path}?${q}`, "Cache-Control": "no-store" } });
  const adapter = getAdapter(gateway);
  if (!adapter) { const f = flashBack("/admin/billing", "error", "درگاه نامعتبر است"); return back(f.dest, f.query); }
  if (!rateLimit(`billing:cb:${ip}`, 30, 60_000).ok) { const f = flashBack("/admin/billing", "error", "درخواست‌های زیاد بود؛ کمی بعد صفحه را دوباره باز کنید (پرداخت شما در صورت انجام، در «تاریخچه‌ی پرداخت‌ها» ثبت می‌شود)."); return back(f.dest, f.query); }

  const q = new URLSearchParams(new URL(req.url).search);
  if (req.method === "POST") {
    try {
      const form = await req.formData();
      for (const [k, v] of form.entries()) if (typeof v === "string" && !q.has(k)) q.set(k, v);
    } catch {
      /* بدنه‌ی نامعتبر: فقط پارامترهای آدرس */
    }
  }
  const parsed = adapter.parseCallback(q);
  const authority = parsed.token ? authorityKey(gateway, parsed.token) : "";
  const r = await verifyPayment(authority, parsed.ok ? "OK" : "NOK");
  const { dest, query } = await paymentReturn(r, authority);
  return back(dest, query);
}

export async function GET(req: Request, { params }: { params: Promise<{ gateway: string }> }) {
  return handle(req, (await params).gateway);
}
export async function POST(req: Request, { params }: { params: Promise<{ gateway: string }> }) {
  return handle(req, (await params).gateway);
}
