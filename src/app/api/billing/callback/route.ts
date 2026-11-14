import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { verifyPayment } from "@/modules/payments/service";

export const dynamic = "force-dynamic";

/**
 * مسیر قدیمی بازگشت (زرین‌پال؛ پارامترهای Authority و Status) — برای تراکنش‌های در جریان و سازگاری حفظ شده است.
 * مسیر جدید و چنددرگاهی: /api/billing/callback/[gateway]
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const ip = clientIpFrom((n) => req.headers.get(n));
  const back = (path: string, q: string) => new Response(null, { status: 303, headers: { Location: `${path}?${q}`, "Cache-Control": "no-store" } });
  if (!rateLimit(`billing:cb:${ip}`, 30, 60_000).ok) return back("/admin/billing", "pay=error&msg=" + encodeURIComponent("درخواست‌های زیاد"));
  const r = await verifyPayment(u.searchParams.get("Authority") || "", u.searchParams.get("Status") || "");
  return back(r.kind === "topup" ? "/admin/wallet" : "/admin/billing", `pay=${r.ok ? "ok" : "error"}&msg=${encodeURIComponent(r.message)}`);
}
